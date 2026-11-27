const db = require("./database");

/**
 * 100% Deterministic Rule-Based Rota Scheduling Engine
 * Enforces:
 * 1. Strict weekly contract fulfillment for round hours (no carry-forward)
 * 2. Alternating weekly carry-forward for non-round hours (38.5h -> 3/4/3/4)
 * 3. Priority for employee repeating patterns (e.g. 4-on / 2-off)
 * 4. Fair alternating weekend distribution (2 weekends on, 2 weekends off)
 * 5. Consecutive working blocks & resting across week transitions
 * 6. Role hierarchy substitutions
 * 7. Zero overstaffing + automated clash & understaffing detection with actionable solutions
 */

async function generateRotaForPeriod(startDateStr, endDateStr, periodLabel) {
  const warnings = [];
  const clashes = [];

  // 1. Fetch live data from database in parallel (1 round-trip instead of 6)
  const [
    employees,
    requirementsList,
    hierarchyList,
    leaveList,
    prefList,
    trainingList
  ] = await Promise.all([
    db.queryAll("SELECT * FROM employees WHERE active = 1"),
    db.queryAll("SELECT * FROM requirements"),
    db.queryAll("SELECT * FROM role_hierarchy ORDER BY priority ASC"),
    db.queryAll("SELECT * FROM leave_records WHERE status = 'Approved'"),
    db.queryAll("SELECT * FROM preferences"),
    db.queryAll("SELECT * FROM training_records")
  ]);

  // Canonical role sorting order
  const roleRankMap = {
    "dy. manager": 1, "deputy manager": 1, "manager": 1,
    "advanced team leader": 2, "clinical lead": 2,
    "team leader": 3,
    "staff nurse": 4,
    "senior carer": 5,
    "carer": 6,
    "physiotherapist": 7,
    "wellbeing staff": 8, "activities": 8,
    "hostes": 9, "hostess": 9,
    "maintance staff": 10, "maintenance": 10
  };

  function getLeaveCode(leaveType) {
    if (!leaveType) return "AL";
    const lt = leaveType.trim().toLowerCase();
    if (lt.includes("sick")) return "SL";
    if (lt.includes("maternity")) return "ML";
    if (lt.includes("compassionate")) return "CL";
    if (lt.includes("annual")) return "AL";
    return "AL";
  }

  function isLeaveStatus(status) {
    return status === "L" || status === "AL" || status === "SL" || status === "ML" || status === "CL";
  }

  function getRoleRank(r) {
    if (!r) return 999;
    const lower = String(r).trim().toLowerCase();
    for (const [k, v] of Object.entries(roleRankMap)) {
      if (lower.includes(k)) return v;
    }
    return 100;
  }

  // Build requirements mapping (Whole-Home + Floor-Wise Quotas)
  const requirements = {};
  let dailyRequiredDayTotal = 0;
  let dailyRequiredNightTotal = 0;

  requirementsList.forEach(r => {
    requirements[r.role_name] = {
      day: r.day_required || 0,
      night: r.night_required || 0,
      topFloor: r.top_floor_required || 0,
      groundFloor: r.ground_floor_required || 0,
      lowerGroundFloor: r.lower_ground_floor_required || 0
    };
    dailyRequiredDayTotal += (r.day_required || 0);
    dailyRequiredNightTotal += (r.night_required || 0);
  });

  // Build hierarchy mapping and role days per week
  const roleHierarchyMap = {};
  const roleDaysPerWeek = {};
  const rolePriorityMap = {};
  hierarchyList.forEach(h => {
    const subs = [h.required_role, h.substitute_1, h.substitute_2, h.substitute_3, h.substitute_4].filter(Boolean);
    roleHierarchyMap[h.required_role] = subs;
    roleDaysPerWeek[h.required_role] = parseInt(h.days_per_week, 10) || 7;
    rolePriorityMap[h.required_role] = parseInt(h.priority, 10);
  });

  // Helper: Base daily quota (ignoring days_per_week)
  function getDailyBaseQuota(role, shiftType) {
    return requirements[role] ? (shiftType === "D" ? (requirements[role].day || 0) : (requirements[role].night || 0)) : 0;
  }

  // Helper: Raw configured days_per_week for a role (defaults to 7)
  function getRoleDaysPerWeek(role) {
    return roleDaysPerWeek[role] !== undefined ? roleDaysPerWeek[role] : 7;
  }

  // Helper: Effective target active days for a role in a given week (supports partial custom-range weeks)
  function getTargetDaysInWeek(maxDays, weekDayCount) {
    if (maxDays >= 7) return weekDayCount;
    if (weekDayCount >= 7) return maxDays;
    return Math.min(maxDays, Math.max(1, Math.round(maxDays * (weekDayCount / 7))));
  }

  // Helper: Compute flexible active required dates for a role within a week
  // Treats "N days/week" as any N days of that week (not hardcoded to Mon..Nth),
  // prioritizing days where staff are actually scheduled, then weekdays before weekends.
  function getFlexibleActiveDaysForRole(weekDays, maxDays, countOnDateFn) {
    if (maxDays >= 7 || !Array.isArray(weekDays) || weekDays.length === 0) {
      return new Set((weekDays || []).map(d => d.dateString));
    }
    const targetDays = getTargetDaysInWeek(maxDays, weekDays.length);
    const dayEntries = weekDays.map((d, idx) => ({
      dateString: d.dateString,
      isWeekend: d.dayName === "Saturday" || d.dayName === "Sunday" || d.dayOfWeek === 0 || d.dayOfWeek === 6,
      idx,
      count: countOnDateFn(d.dateString)
    }));

    const active = new Set();

    // 1. Pick worked days first (highest coverage first, weekdays before weekends, chronological)
    const workedDays = dayEntries
      .filter(e => e.count > 0)
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        if (a.isWeekend !== b.isWeekend) return a.isWeekend ? 1 : -1;
        return a.idx - b.idx;
      });

    for (const e of workedDays) {
      if (active.size >= targetDays) break;
      active.add(e.dateString);
    }

    // 2. Fill any unmet required days from unworked days (weekdays first, then weekends, chronological)
    if (active.size < targetDays) {
      const unworkedDays = dayEntries
        .filter(e => !active.has(e.dateString))
        .sort((a, b) => {
          if (a.isWeekend !== b.isWeekend) return a.isWeekend ? 1 : -1;
          return a.idx - b.idx;
        });
      for (const e of unworkedDays) {
        if (active.size >= targetDays) break;
        active.add(e.dateString);
      }
    }

    return active;
  }

  // Helper: Get scheduling quota for role on a given day (flexible Mon-Fri for <=5 days/week roles)
  function getRequiredQuota(role, shiftType, dayInfo, allowAnyDay = false) {
    const base = getDailyBaseQuota(role, shiftType);
    if (base <= 0) return 0;
    let maxDays = getRoleDaysPerWeek(role);
    // Pooled floor lead roles (Staff Nurse / Team Leader / Advanced Team Leader) can cover 7-day floor lead pools
    if (shiftType === "D" && (role === "Staff Nurse" || role === "Team Leader" || role === "Advanced Team Leader")) {
      maxDays = Math.max(
        maxDays,
        roleDaysPerWeek["Staff Nurse"] || 7,
        roleDaysPerWeek["Team Leader"] || 7,
        roleDaysPerWeek["Advanced Team Leader"] || 7
      );
    }
    if (maxDays >= 7 || allowAnyDay) return base;
    // Monday = 0, Tuesday = 1, ..., Friday = 4, Saturday = 5, Sunday = 6
    const dIdxInWeek = (dayInfo.dayOfWeek + 6) % 7;
    // Flexible N days/week: roles with <=5 days/week are eligible on any weekday (Mon-Fri);
    // 6 days/week roles are eligible Mon-Sat. Weekly cap is enforced across the week.
    const eligibleDaySpan = Math.max(5, maxDays);
    if (dIdxInWeek >= eligibleDaySpan) return 0;
    return base;
  }

  // Floor-Wise Quota & Pool Helpers (Option A: Floor-Specific Rules)
  const VALID_FLOORS = ["Top Floor", "Ground Floor", "Lower Ground Floor"];

  function getFloorPoolKey(floorName, roleName) {
    if (floorName === "Top Floor" && (roleName === "Staff Nurse" || roleName === "Team Leader" || roleName === "Advanced Team Leader")) {
      return "TOP_SN_TL_POOL";
    }
    if ((floorName === "Ground Floor" || floorName === "Lower Ground Floor") && (roleName === "Team Leader" || roleName === "Advanced Team Leader")) {
      return "FLOOR_TL_POOL";
    }
    return roleName;
  }

  function getFloorPoolRoles(floorName, roleName) {
    if (floorName === "Top Floor" && (roleName === "Staff Nurse" || roleName === "Team Leader" || roleName === "Advanced Team Leader")) {
      return ["Staff Nurse", "Team Leader", "Advanced Team Leader"];
    }
    if ((floorName === "Ground Floor" || floorName === "Lower Ground Floor") && (roleName === "Team Leader" || roleName === "Advanced Team Leader")) {
      return ["Team Leader", "Advanced Team Leader"];
    }
    return [roleName];
  }

  function getFloorPoolQuota(floorName, roleName, dayInfo) {
    const poolRoles = getFloorPoolRoles(floorName, roleName);
    const maxDays = Math.max(...poolRoles.map(r => roleDaysPerWeek[r] !== undefined ? roleDaysPerWeek[r] : 7));
    const dIdxInWeek = (dayInfo.dayOfWeek + 6) % 7;
    if (maxDays < 7 && dIdxInWeek >= Math.max(5, maxDays)) return 0;

    const getFloorVal = (rName, fName) => {
      const req = requirements[rName];
      if (!req) return 0;
      if (fName === "Top Floor") return req.topFloor || 0;
      if (fName === "Ground Floor") return req.groundFloor || 0;
      if (fName === "Lower Ground Floor") return req.lowerGroundFloor || 0;
      return 0;
    };

    if (floorName === "Top Floor" && (roleName === "Staff Nurse" || roleName === "Team Leader" || roleName === "Advanced Team Leader")) {
      return Math.max(
        getFloorVal("Staff Nurse", "Top Floor"),
        getFloorVal("Team Leader", "Top Floor"),
        getFloorVal("Advanced Team Leader", "Top Floor")
      );
    }
    if ((floorName === "Ground Floor" || floorName === "Lower Ground Floor") && (roleName === "Team Leader" || roleName === "Advanced Team Leader")) {
      return Math.max(
        getFloorVal("Team Leader", floorName),
        getFloorVal("Advanced Team Leader", floorName)
      );
    }
    return getFloorVal(roleName, floorName);
  }

  function isFloorManagedRole(roleName) {
    const checkRoles = (roleName === "Staff Nurse" || roleName === "Team Leader" || roleName === "Advanced Team Leader")
      ? ["Staff Nurse", "Team Leader", "Advanced Team Leader"]
      : [roleName];
    return checkRoles.some(rName => {
      const req = requirements[rName];
      return req && ((req.topFloor || 0) + (req.groundFloor || 0) + (req.lowerGroundFloor || 0) > 0);
    });
  }

  // Build calendar days for the requested period (supports any Custom Start Date & End Date)
  const calendarDays = [];
  const sParts = startDateStr.split("-").map(Number);
  const eParts = endDateStr.split("-").map(Number);
  const curDate = new Date(Date.UTC(sParts[0], sParts[1] - 1, sParts[2]));
  const endDate = new Date(Date.UTC(eParts[0], eParts[1] - 1, eParts[2]));

  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  while (curDate <= endDate) {
    const y = curDate.getUTCFullYear();
    const m = String(curDate.getUTCMonth() + 1).padStart(2, "0");
    const d = String(curDate.getUTCDate()).padStart(2, "0");
    const dStr = `${y}-${m}-${d}`;
    const dayName = dayNames[curDate.getUTCDay()];

    calendarDays.push({
      dateString: dStr,
      dayName: dayName,
      isWeekend: dayName === "Saturday" || dayName === "Sunday",
      dayOfWeek: curDate.getUTCDay()
    });

    curDate.setUTCDate(curDate.getUTCDate() + 1);
  }

  // Group calendarDays into Monday-to-Sunday calendar weeks (handles both standard 28-day & custom date ranges)
  const weeks = [];
  const isStandard7DayAligned = (calendarDays.length % 7 === 0) && (calendarDays.length > 0 && calendarDays[0].dayName === "Monday");
  if (isStandard7DayAligned) {
    for (let i = 0; i < calendarDays.length; i += 7) {
      weeks.push(calendarDays.slice(i, i + 7));
    }
  } else {
    let currentWeekChunk = [];
    calendarDays.forEach((dayObj, idx) => {
      if (idx > 0 && dayObj.dayName === "Monday") {
        weeks.push(currentWeekChunk);
        currentWeekChunk = [];
      }
      currentWeekChunk.push(dayObj);
    });
    if (currentWeekChunk.length > 0) {
      weeks.push(currentWeekChunk);
    }
  }

  // 1B. Previous Period 7-Day Boundary Lookback (protects consecutive streaks, night-to-day turnaround, and split-week hours)
  const prevCalendarDays = [];
  const lookbackStart = new Date(Date.UTC(sParts[0], sParts[1] - 1, sParts[2]));
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 7);
  for (let i = 0; i < 7; i++) {
    const y = lookbackStart.getUTCFullYear();
    const m = String(lookbackStart.getUTCMonth() + 1).padStart(2, "0");
    const d = String(lookbackStart.getUTCDate()).padStart(2, "0");
    const dStr = `${y}-${m}-${d}`;
    const dayName = dayNames[lookbackStart.getUTCDay()];
    prevCalendarDays.push({
      dateString: dStr,
      dayName: dayName,
      dayOfWeek: lookbackStart.getUTCDay()
    });
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() + 1);
  }

  const prevShiftsByEmp = {};
  try {
    const earliestLookbackDate = prevCalendarDays[0].dateString;
    const priorSavedRotas = await db.queryAll(
      "SELECT start_date, end_date, rota_json FROM saved_rotas WHERE start_date < ? AND end_date >= ? ORDER BY id DESC LIMIT 2",
      [startDateStr, earliestLookbackDate]
    );
    const prevDateSet = new Set(prevCalendarDays.map(d => d.dateString));
    for (const row of (priorSavedRotas || [])) {
      if (row.start_date === startDateStr && row.end_date === endDateStr) continue;
      if (row.end_date < prevCalendarDays[0].dateString) continue;
      try {
        const parsed = JSON.parse(row.rota_json);
        (parsed.rota || []).forEach(r => {
          if (prevDateSet.has(r.date)) {
            const empKey = String(r.employeeId);
            if (!prevShiftsByEmp[empKey]) prevShiftsByEmp[empKey] = {};
            // Only set if not already populated by a newer saved rota
            if (!prevShiftsByEmp[empKey][r.date]) {
              prevShiftsByEmp[empKey][r.date] = {
                shift: r.shift,
                status: r.status
              };
            }
          }
        });
      } catch (ignoreErr) {}
    }
  } catch (lookbackErr) {
    // Safe fallback if no prior rotas exist
  }

  // Helper to get shift assignment at calendar index (supports negative indices into the 7-day lookback window)
  function getShiftAtCalendarIdx(state, idx) {
    if (idx >= 0 && idx < calendarDays.length) {
      return state.assignedShifts[calendarDays[idx].dateString] || null;
    }
    if (idx < 0) {
      const prevIdx = prevCalendarDays.length + idx;
      if (prevIdx >= 0 && prevIdx < prevCalendarDays.length) {
        const pDate = prevCalendarDays[prevIdx].dateString;
        return (prevShiftsByEmp[String(state.id)] && prevShiftsByEmp[String(state.id)][pDate]) || null;
      }
    }
    return null;
  }

  // 1C. Build Family Member Groups (Bidirectional + Transitive Closure from Preferences type === 'family')
  const familyAdj = {};
  prefList.filter(p => p.type === "family").forEach(p => {
    const empA = String(p.employee_id || "").trim();
    const empB = String(p.target_day || p.target_date || "").trim();
    if (empA && empB && empA !== empB) {
      if (!familyAdj[empA]) familyAdj[empA] = new Set();
      if (!familyAdj[empB]) familyAdj[empB] = new Set();
      familyAdj[empA].add(empB);
      familyAdj[empB].add(empA);
    }
  });

  // Compute connected components so any linked family group shares all peers
  const familyPeersMap = {};
  const familyGroupLeaderMap = {};
  Object.keys(familyAdj).forEach(startId => {
    const visited = new Set([startId]);
    const queue = [startId];
    while (queue.length > 0) {
      const curr = queue.shift();
      const neighbors = familyAdj[curr] || new Set();
      neighbors.forEach(nb => {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push(nb);
        }
      });
    }
    const sortedGroup = Array.from(visited).sort();
    const leaderId = sortedGroup[0];
    familyGroupLeaderMap[startId] = leaderId;
    familyPeersMap[startId] = sortedGroup.filter(id => id !== startId);
  });

  // 2. Setup employee state, contract hours & patterns
  const empState = {};
  const isStandard28DayCycle = (calendarDays.length === 28 && weeks.length === 4 && weeks.every(w => w.length === 7));
  const totalPeriodWeeksFloat = calendarDays.length / 7;

  employees.forEach(emp => {
    const shiftHours = parseFloat(emp.shift_hours) || 11.0;
    const contractHours = parseFloat(emp.contract_hours) || 0;
    const isRound = (contractHours % shiftHours === 0);

    const weeklyTargets = [];
    const nominalPeriodContractHours = Math.round(contractHours * totalPeriodWeeksFloat * 10) / 10;
    const maxAllowedShifts = Math.floor((nominalPeriodContractHours + 0.001) / shiftHours);

    if (isStandard28DayCycle) {
      if (isRound) {
        const shiftsPerWeek = Math.round(contractHours / shiftHours);
        for (let w = 0; w < weeks.length; w++) {
          weeklyTargets.push(shiftsPerWeek);
        }
      } else {
        let remaining = maxAllowedShifts;
        for (let w = 0; w < weeks.length; w++) {
          const weeksLeft = weeks.length - w;
          const shifts = Math.round(remaining / weeksLeft);
          weeklyTargets.push(shifts);
          remaining -= shifts;
        }
      }
    } else {
      // Custom Date Range: Pro-rate weekly shift targets proportionally to each week's day count (wDays.length / 7)
      let remainingShifts = maxAllowedShifts;
      let remainingDays = calendarDays.length;
      for (let w = 0; w < weeks.length; w++) {
        const wDayCount = weeks[w].length;
        if (w === weeks.length - 1 || remainingDays <= wDayCount) {
          weeklyTargets.push(Math.max(0, remainingShifts));
          remainingShifts = 0;
        } else {
          const share = Math.round(remainingShifts * (wDayCount / remainingDays));
          weeklyTargets.push(share);
          remainingShifts -= share;
          remainingDays -= wDayCount;
        }
      }
    }

    const totalMonthlyTargetShifts = weeklyTargets.reduce((a, b) => a + b, 0);

    // Check pattern preference — always pick the newest pattern row (id DESC) with type-safe ID matching
    const sortedPrefsNewestFirst = [...prefList].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
    let empPattern = sortedPrefsNewestFirst.find(p => String(p.employee_id) === String(emp.id) && p.type === "pattern");
    const peers = familyPeersMap[String(emp.id)] || [];
    if (!empPattern && peers.length > 0) {
      for (const peerId of peers) {
        const peerPat = sortedPrefsNewestFirst.find(p => String(p.employee_id) === String(peerId) && p.type === "pattern");
        if (peerPat) {
          empPattern = peerPat;
          break;
        }
      }
    }

    empState[emp.id] = {
      id: emp.id,
      name: emp.name,
      designation: emp.designation,
      floor: (emp.floor || "").trim(),
      staffType: emp.staff_type || "D",
      contractHours: contractHours,
      shiftHours: shiftHours,
      isRound: isRound,
      weeklyTargets: weeklyTargets,
      totalMonthlyTargetShifts: totalMonthlyTargetShifts,
      pattern: empPattern || null,
      familyPeers: peers,
      familyGroupId: familyGroupLeaderMap[String(emp.id)] || null,
      assignedShifts: {}, // dateString -> { shift: 'D'|'N'|'OFF'|'L'|'TR', status: 'D'|'N'|'OFF'|'L'|'TR', role: 'Carer' }
      totalShiftsWorked: 0,
      totalHoursWorked: 0,
      weekendCohort: "A",
      weekendsWorkedCount: 0
    };
  });

  // Helper to align fractional contract weekly targets with weekend cohort on standard 4-week & custom cycles
  function syncFractionalWeeklyTargetsForCohort(st) {
    if (!st.isRound) {
      if (isStandard28DayCycle) {
        if (st.contractHours === 38.5 || st.contractHours === 40) {
          st.weeklyTargets = st.weekendCohort === "A" ? [4, 3, 4, 3] : [3, 4, 3, 4];
        } else if (st.contractHours === 15) {
          st.weeklyTargets = st.weekendCohort === "A" ? [1, 1, 2, 1] : [1, 2, 1, 1];
        }
        st.totalMonthlyTargetShifts = st.weeklyTargets.reduce((a, b) => a + b, 0);
      } else if (st.contractHours === 38.5 || st.contractHours === 40) {
        const nominalPeriodContractHours = Math.round(st.contractHours * totalPeriodWeeksFloat * 10) / 10;
        let remainingShifts = Math.floor((nominalPeriodContractHours + 0.001) / st.shiftHours);
        const newTargets = [];
        for (let w = 0; w < weeks.length; w++) {
          const wDayCount = weeks[w].length;
          const isWkWork = (w % 2 === 0 && st.weekendCohort === "A") || (w % 2 === 1 && st.weekendCohort === "B");
          const fullWeekTarget = isWkWork ? 4 : 3;
          if (w === weeks.length - 1) {
            newTargets.push(Math.max(0, Math.min(5, remainingShifts)));
            remainingShifts = 0;
          } else {
            const target = wDayCount === 7 ? fullWeekTarget : Math.round(fullWeekTarget * (wDayCount / 7));
            const clamped = Math.max(0, Math.min(remainingShifts, target));
            newTargets.push(clamped);
            remainingShifts -= clamped;
          }
        }
        st.weeklyTargets = newTargets;
        st.totalMonthlyTargetShifts = st.weeklyTargets.reduce((a, b) => a + b, 0);
      }
    }
  }

  // Assign alternating weekend cohorts (A vs B) PER FLOOR POOL & ROLE (Change #1)
  // Cohort A: Works even-indexed weeks (W1, W3, W5...)
  // Cohort B: Works odd-indexed weeks (W2, W4, W6...)
  // Pooled floor roles (e.g. Top Floor Staff Nurse + Advanced Team Leader + Team Leader) are grouped together
  // so they alternate weekends with each other instead of landing in the same cohort.
  const roleGroups = {};
  Object.values(empState).forEach(st => {
    const poolKey = (st.staffType === "D" && st.floor && VALID_FLOORS.includes(st.floor))
      ? getFloorPoolKey(st.floor, st.designation)
      : st.designation;
    const k = st.staffType + "_" + poolKey;
    if (!roleGroups[k]) roleGroups[k] = [];
    roleGroups[k].push(st);
  });

  // Non-Top Floor Daily Clinical/Senior Safeguard Helpers (Ground Floor & Lower Ground Floor)
  // Ensures at least 1 Staff Nurse OR Senior Carer is scheduled every day on non-Top floors where both are required.
  const NON_TOP_SN_SC_FLOORS = ["Ground Floor", "Lower Ground Floor"];
  function isFloorRequiringSnOrSc(floorName) {
    if (!NON_TOP_SN_SC_FLOORS.includes(floorName)) return false;
    const snReq = requirements["Staff Nurse"];
    const scReq = requirements["Senior Carer"];
    const getVal = (req) => {
      if (!req) return 0;
      return floorName === "Ground Floor" ? (req.groundFloor || 0) : (req.lowerGroundFloor || 0);
    };
    return getVal(snReq) > 0 && getVal(scReq) > 0;
  }

  Object.values(roleGroups).forEach(group => {
    // Sort by floor first so staff on the same floor are adjacent and split 50/50 between Cohort A and Cohort B,
    // while single-person floor roles also alternate A/B across floors.
    group.sort((a, b) => {
      const fCmp = (a.floor || "").localeCompare(b.floor || "");
      if (fCmp !== 0) return fCmp;
      return String(a.id).localeCompare(String(b.id));
    });
    group.forEach((st, idx) => {
      st.weekendCohort = idx % 2 === 0 ? "A" : "B";
      syncFractionalWeeklyTargetsForCohort(st);
    });
  });

  // Stagger Weekend Cohorts across Staff Nurse & Senior Carer on Ground / Lower Ground Floor
  // so neither Cohort A nor Cohort B weekends are left with 0 Staff Nurse AND 0 Senior Carer.
  NON_TOP_SN_SC_FLOORS.forEach(floorName => {
    if (!isFloorRequiringSnOrSc(floorName)) return;
    const floorSn = Object.values(empState).filter(s => s.staffType === "D" && s.floor === floorName && s.designation === "Staff Nurse");
    const floorSc = Object.values(empState).filter(s => s.staffType === "D" && s.floor === floorName && s.designation === "Senior Carer");
    if (floorSn.length === 0 || floorSc.length === 0) return;

    const snA = floorSn.filter(s => s.weekendCohort === "A").length;
    const snB = floorSn.length - snA;
    const scA = floorSc.filter(s => s.weekendCohort === "A").length;
    const scB = floorSc.length - scA;

    if ((snA + scA === 0) || (snB + scB === 0)) {
      floorSc.forEach(st => {
        st.weekendCohort = st.weekendCohort === "A" ? "B" : "A";
        syncFractionalWeeklyTargetsForCohort(st);
      });
    }
  });

  // Synchronize Weekend Cohort (A or B) for Linked Family Members (Change #2: Family Members Together)
  const familyLeaderCohort = {};
  Object.values(empState).forEach(st => {
    if (st.familyGroupId) {
      if (!familyLeaderCohort[st.familyGroupId]) {
        const leaderState = empState[st.familyGroupId];
        familyLeaderCohort[st.familyGroupId] = leaderState ? leaderState.weekendCohort : st.weekendCohort;
      }
    }
  });
  Object.values(empState).forEach(st => {
    if (st.familyGroupId && familyLeaderCohort[st.familyGroupId]) {
      st.weekendCohort = familyLeaderCohort[st.familyGroupId];
      syncFractionalWeeklyTargetsForCohort(st);
    }
  });

  // Helper: Check if employee has a Consecutive-Block Pattern (N working days / 0 or null rest days -> consecutive block + alternating weekends)
  function isConsecutiveBlockPattern(state) {
    return Boolean(
      state &&
      state.pattern &&
      Number(state.pattern.pattern_work_days) > 0 &&
      (
        state.pattern.pattern_off_days === null ||
        state.pattern.pattern_off_days === undefined ||
        state.pattern.pattern_off_days === "" ||
        Number(state.pattern.pattern_off_days) === 0
      )
    );
  }

  // Helper: Evaluate Rolling Repeating Pattern (work > 0 AND off > 0)
  function isPatternWorkDay(state, targetDateStr) {
    if (!state.pattern || !state.pattern.pattern_work_days || !state.pattern.pattern_off_days) {
      return null; // No rolling pattern (includes 0 rest days consecutive-block mode)
    }
    const anchorStr = state.pattern.pattern_start_date || startDateStr;
    const anchor = new Date(anchorStr + "T00:00:00Z");
    const target = new Date(targetDateStr + "T00:00:00Z");
    const diffDays = Math.round((target - anchor) / (1000 * 60 * 60 * 24));
    const cycle = state.pattern.pattern_work_days + state.pattern.pattern_off_days;
    const phase = ((diffDays % cycle) + cycle) % cycle;
    return phase < state.pattern.pattern_work_days;
  }

  // 3. Pre-mark Approved Leave (Proportional allocation per week)
  employees.forEach(emp => {
    const state = empState[emp.id];
    const empLeaves = leaveList.filter(l => l.employee_id === emp.id);
    if (empLeaves.length === 0) return;

    weeks.forEach((weekDays, weekIdx) => {
      // Find days in this week that fall in approved leave
      const leaveDaysInWeek = weekDays.filter(day => {
        return empLeaves.some(l => day.dateString >= l.start_date && day.dateString <= l.end_date);
      });

      if (leaveDaysInWeek.length === 0) return;

      if (leaveDaysInWeek.length === 1) {
        // Single day leave: exactly on that day
        const day = leaveDaysInWeek[0];
        const matchingLeave = empLeaves.find(l => day.dateString >= l.start_date && day.dateString <= l.end_date);
        const lCode = getLeaveCode(matchingLeave ? matchingLeave.leave_type : "Annual Leave");
        state.assignedShifts[day.dateString] = {
          shift: "OFF",
          status: lCode,
          coveringRole: "",
          isLeave: true,
          leaveType: matchingLeave ? matchingLeave.leave_type : "Annual Leave"
        };
      } else {
        // Multi-day / long leave: record leave up to weekly contracted shifts
        const targetShifts = state.weeklyTargets[weekIdx] || Math.round(state.contractHours / state.shiftHours) || 4;

        if (leaveDaysInWeek.length <= targetShifts) {
          leaveDaysInWeek.forEach(day => {
            const matchingLeave = empLeaves.find(l => day.dateString >= l.start_date && day.dateString <= l.end_date);
            const lCode = getLeaveCode(matchingLeave ? matchingLeave.leave_type : "Annual Leave");
            state.assignedShifts[day.dateString] = {
              shift: "OFF",
              status: lCode,
              coveringRole: "",
              isLeave: true,
              leaveType: matchingLeave ? matchingLeave.leave_type : "Annual Leave"
            };
          });
        } else {
          // Sort candidate leave days: prioritize pattern work days or standard work days
          const sorted = [...leaveDaysInWeek].sort((a, b) => {
            const patA = isPatternWorkDay(state, a.dateString) === true ? 1 : 0;
            const patB = isPatternWorkDay(state, b.dateString) === true ? 1 : 0;
            if (patB !== patA) return patB - patA;
            // Prefer weekdays over weekends unless weekend working week
            const isWkA = a.isWeekend ? 1 : 0;
            const isWkB = b.isWeekend ? 1 : 0;
            return isWkA - isWkB;
          });

          // Allotted up to targetShifts as leave, remainder as "OFF" (protected from work)
          sorted.forEach((day, idx) => {
            const matchingLeave = empLeaves.find(l => day.dateString >= l.start_date && day.dateString <= l.end_date);
            const lCode = getLeaveCode(matchingLeave ? matchingLeave.leave_type : "Annual Leave");
            if (idx < targetShifts) {
              state.assignedShifts[day.dateString] = {
                shift: "OFF",
                status: lCode,
                coveringRole: "",
                isLeave: true,
                leaveType: matchingLeave ? matchingLeave.leave_type : "Annual Leave"
              };
            } else {
              state.assignedShifts[day.dateString] = {
                shift: "OFF",
                status: "OFF",
                coveringRole: "",
                leaveProtected: true,
                leaveType: matchingLeave ? matchingLeave.leave_type : "Annual Leave"
              };
            }
          });
        }
      }
    });
  });

  // 4. Pre-mark Training
  trainingList.forEach(t => {
    const state = empState[t.employee_id];
    if (state && t.training_date) {
      if (!state.assignedShifts[t.training_date] || !isLeaveStatus(state.assignedShifts[t.training_date].status)) {
        state.assignedShifts[t.training_date] = {
          shift: "D",
          status: "TR",
          coveringRole: "Training",
          trainingName: t.training_name
        };
      }
    }
  });

  // Night Staff Training Safety Rule:
  // If an employee works Night shift (staffType === 'N') and has daytime training on date T,
  // the previous night (T - 1) must be mandatory OFF (rest before morning training).
  trainingList.forEach(t => {
    const state = empState[t.employee_id];
    if (state && state.staffType === "N" && t.training_date) {
      const tIdx = calendarDays.findIndex(d => d.dateString === t.training_date);
      if (tIdx > 0) {
        const prevDayStr = calendarDays[tIdx - 1].dateString;
        const curAsgn = state.assignedShifts[prevDayStr];
        if (!curAsgn || !isLeaveStatus(curAsgn.status)) {
          state.assignedShifts[prevDayStr] = {
            shift: "OFF",
            status: "OFF",
            coveringRole: "",
            isNightTrainingRest: true,
            note: "Mandatory rest before daytime training"
          };
        }
      }
    }
  });

  // Helper: Check if employee has negative preference (unavailable/off)
  function isUnavailable(empId, dStr, dayName) {
    return prefList.some(p => {
      if (String(p.employee_id) !== String(empId)) return false;
      if (p.preference !== "unavailable" && p.preference !== "off") return false;
      if (p.type === "date" && p.target_date === dStr) return true;
      if (p.type === "day" && p.target_day && p.target_day.toLowerCase().includes(dayName.toLowerCase())) return true;
      return false;
    });
  }

  // Helper: Check if employee specifically requested this exact date off (type === 'date' AND preference === 'unavailable' | 'off')
  function isSpecificDateRequestedOff(empId, dStr) {
    return prefList.some(p => {
      if (String(p.employee_id) !== String(empId)) return false;
      if (p.type !== "date") return false;
      if (p.preference !== "unavailable" && p.preference !== "off") return false;
      return p.target_date === dStr;
    });
  }

  // Helper: Check positive preference
  function hasPositivePref(empId, dStr, dayName) {
    return prefList.some(p => {
      if (String(p.employee_id) !== String(empId)) return false;
      if (p.preference !== "prefer") return false;
      if (p.type === "date" && p.target_date === dStr) return true;
      if (p.type === "day" && p.target_day && p.target_day.toLowerCase().includes(dayName.toLowerCase())) return true;
      return false;
    });
  }

  // Family Synchronization Helpers (Change #2: Family Members Together)
  function hasFamilyWorkingOnDate(st, dStr) {
    if (!st.familyPeers || st.familyPeers.length === 0) return false;
    return st.familyPeers.some(peerId => {
      const peer = empState[peerId];
      if (!peer) return false;
      const asgn = peer.assignedShifts[dStr];
      return asgn && (asgn.shift === "D" || asgn.shift === "N") && asgn.status !== "TR";
    });
  }

  function hasFamilyPositivePrefOnDate(st, dStr, dayName) {
    if (!st.familyPeers || st.familyPeers.length === 0) return false;
    return st.familyPeers.some(peerId => {
      const peer = empState[peerId];
      if (!peer) return false;
      if (isPatternWorkDay(peer, dStr) === true) return true;
      if (hasPositivePref(peer.id, dStr, dayName)) return true;
      return false;
    });
  }

  function hasFamilyOffOrUnavailableOnDate(st, dStr, dayName) {
    if (!st.familyPeers || st.familyPeers.length === 0) return false;
    return st.familyPeers.some(peerId => {
      const peer = empState[peerId];
      if (!peer) return false;
      if (isUnavailable(peer.id, dStr, dayName)) return true;
      const asgn = peer.assignedShifts[dStr];
      if (asgn && (isLeaveStatus(asgn.status) || asgn.isLeave || asgn.leaveProtected || asgn.isNightTrainingRest)) {
        return true;
      }
      return false;
    });
  }

  function compareFamilyPriority(a, b, dStr, dayName) {
    // 1. Strongly prefer candidate whose linked family member is ALREADY scheduled to work on dStr
    const aFamWork = hasFamilyWorkingOnDate(a, dStr) ? 1 : 0;
    const bFamWork = hasFamilyWorkingOnDate(b, dStr) ? 1 : 0;
    if (bFamWork !== aFamWork) return bFamWork - aFamWork;

    // 2. Avoid scheduling candidate on a day where their linked family member is on leave or unavailable
    const aFamOff = hasFamilyOffOrUnavailableOnDate(a, dStr, dayName) ? 1 : 0;
    const bFamOff = hasFamilyOffOrUnavailableOnDate(b, dStr, dayName) ? 1 : 0;
    if (aFamOff !== bFamOff) return aFamOff - bFamOff;

    return 0;
  }

  // Floor Roster Population Check (for Option A Floor-Wise Rules)
  function doesFloorHaveRosterForRole(floorName, roleName) {
    const poolRoles = getFloorPoolRoles(floorName, roleName);
    return Object.values(empState).some(s =>
      s.staffType === "D" &&
      (s.floor || "") === floorName &&
      poolRoles.includes(s.designation)
    );
  }

  function getEffectiveFloorQuotaCap(floorName, roleName, dayInfo) {
    const fQuota = getFloorPoolQuota(floorName, roleName, dayInfo);
    const reqQuota = getRequiredQuota(roleName, "D", dayInfo);
    const otherFloors = VALID_FLOORS.filter(f => f !== floorName);

    let otherPopulatedFloorsQuotaSum = 0;
    otherFloors.forEach(otherF => {
      if (doesFloorHaveRosterForRole(otherF, roleName)) {
        otherPopulatedFloorsQuotaSum += getFloorPoolQuota(otherF, roleName, dayInfo);
      }
    });

    if (fQuota > 0 && otherPopulatedFloorsQuotaSum > 0) {
      // Normal multi-floor setup: strictly enforce this floor's own quota (Option A)
      return fQuota;
    }
    return Math.max(fQuota, reqQuota - otherPopulatedFloorsQuotaSum);
  }

  // 5. Week-by-Week Scheduling Loop
  weeks.forEach((weekDays, weekIdx) => {
    // Determine weekly targets for all staff with leave & prior-period split-week deductions
    employees.forEach(emp => {
      const state = empState[emp.id];
      state.shiftsThisWeek = 0;

      let leaveCount = 0;
      weekDays.forEach(d => {
        const asgn = state.assignedShifts[d.dateString];
        if (asgn && (isLeaveStatus(asgn.status) || asgn.isLeave)) leaveCount++;
      });

      // If Week 0 starts mid-week (not Monday), deduct shifts already worked earlier in the same calendar week from prior period
      let priorSameWeekWorked = 0;
      if (weekIdx === 0 && weekDays.length > 0 && weekDays[0].dayName !== "Monday") {
        const firstDayIdxInWeek = (weekDays[0].dayOfWeek + 6) % 7; // Mon=0..Sun=6
        for (let back = 1; back <= firstDayIdxInWeek; back++) {
          const prevAsgn = getShiftAtCalendarIdx(state, -back);
          if (prevAsgn && (prevAsgn.shift === "D" || prevAsgn.shift === "N" || isLeaveStatus(prevAsgn.status))) {
            priorSameWeekWorked++;
          }
        }
      }

      const baseWeekly = state.weeklyTargets[weekIdx] || 0;
      let pastTarget = 0;
      for (let w = 0; w < weekIdx; w++) {
        pastTarget += state.weeklyTargets[w] || 0;
      }
      const shortfall = Math.max(0, pastTarget - state.totalShiftsWorked);
      const remainingMonthlyNeeded = Math.max(0, state.totalMonthlyTargetShifts - state.totalShiftsWorked);
      const isMaintenance = Boolean(state.designation && state.designation.toLowerCase().includes("maint"));
      const maxWeeklyCap = isMaintenance ? 5 : Math.max(4, baseWeekly);
      const allowedThisWeek = Math.min(maxWeeklyCap, Math.min(remainingMonthlyNeeded, baseWeekly + shortfall));
      if (weekIdx === 0 && weekDays.length < 7 && priorSameWeekWorked > 0) {
        const fullWeekTarget = Math.max(baseWeekly, Math.ceil(state.contractHours / state.shiftHours));
        const remInSplitCalendarWeek = Math.max(0, fullWeekTarget - priorSameWeekWorked - leaveCount);
        state.workShiftsAllowedThisWeek = Math.min(Math.max(0, allowedThisWeek - leaveCount), remInSplitCalendarWeek);
      } else {
        state.workShiftsAllowedThisWeek = Math.max(0, allowedThisWeek - leaveCount - priorSameWeekWorked);
      }
      state.isWeekendWorkingWeek = (weekIdx % 2 === 0 && state.weekendCohort === "A") ||
                                   (weekIdx % 2 === 1 && state.weekendCohort === "B");
      state.consecutiveBlockDates = null;
    });

    // Compute Consecutive Weekly Block targets for employees with "N Working / 0 Rest" pattern
    // Strictly preserves Alternating Weekend Rotation (isWeekendWorkingWeek) & consecutive-day fatigue limits
    const weekStartCalIdx = weekDays.length > 0 ? calendarDays.findIndex(d => d.dateString === weekDays[0].dateString) : -1;
    Object.values(empState).forEach(state => {
      if (!isConsecutiveBlockPattern(state)) return;
      const blockLen = Math.min(state.workShiftsAllowedThisWeek, Number(state.pattern.pattern_work_days) || 0);
      if (blockLen <= 0 || weekDays.length === 0 || weekStartCalIdx === -1) return;

      const isMaintenance = Boolean(state.designation && state.designation.toLowerCase().includes("maint"));
      const maxConsecutive = isMaintenance ? 5 : 4;
      const effectiveLen = Math.min(blockLen, maxConsecutive);

      // Trailing consecutive shifts ending the day before this week starts (including 7-day previous period lookback)
      let trailingStreak = 0;
      for (let i = weekStartCalIdx - 1; i >= -7; i--) {
        const prev = getShiftAtCalendarIdx(state, i);
        if (prev && (prev.shift === "D" || prev.shift === "N")) trailingStreak++;
        else break;
      }

      const legal = weekDays.map((d, idx) => {
        if (state.assignedShifts[d.dateString]) return false;
        if (isUnavailable(state.id, d.dateString, d.dayName)) return false;
        // Strictly enforce Alternating Weekend Rotation
        if (d.isWeekend && !state.isWeekendWorkingWeek) return false;
        if (idx === 0 && state.staffType === "D") {
          const prev = getShiftAtCalendarIdx(state, weekStartCalIdx - 1);
          if (prev && prev.shift === "N") return false;
        }
        if (state.staffType === "N" && (weekStartCalIdx + idx) < calendarDays.length - 1) {
          const nextDay = calendarDays[weekStartCalIdx + idx + 1];
          const nextAsgn = state.assignedShifts[nextDay.dateString];
          if (nextAsgn && nextAsgn.status === "TR") return false;
        }
        return true;
      });

      const candidateWindows = [];
      for (let start = 0; start <= weekDays.length - effectiveLen; start++) {
        let ok = true;
        for (let j = start; j < start + effectiveLen; j++) {
          if (!legal[j]) { ok = false; break; }
        }
        if (!ok) continue;
        // Protect max consecutive streak across week boundary
        if (start === 0 && (trailingStreak + effectiveLen) > maxConsecutive) continue;

        const winDays = weekDays.slice(start, start + effectiveLen);
        const weekendCount = winDays.filter(d => d.isWeekend).length;
        const prefHits = winDays.filter(d => hasPositivePref(state.id, d.dateString, d.dayName)).length;
        let famOverlap = 0;
        if (state.familyPeers && state.familyPeers.length > 0) {
          state.familyPeers.forEach(pid => {
            const peer = empState[pid];
            if (peer && peer.consecutiveBlockDates) {
              winDays.forEach(d => { if (peer.consecutiveBlockDates.has(d.dateString)) famOverlap++; });
            }
          });
        }
        candidateWindows.push({ start, winDays, weekendCount, prefHits, famOverlap });
      }

      if (candidateWindows.length > 0) {
        candidateWindows.sort((a, b) => {
          // 1. On working weekends, prioritize block anchored to Sat & Sun (e.g. Thu-Fri-Sat-Sun)
          if (state.isWeekendWorkingWeek && b.weekendCount !== a.weekendCount) {
            return b.weekendCount - a.weekendCount;
          }
          // 2. Match linked family member's consecutive block if set
          if (b.famOverlap !== a.famOverlap) return b.famOverlap - a.famOverlap;
          // 3. Honor positive preferences
          if (b.prefHits !== a.prefHits) return b.prefHits - a.prefHits;
          // 4. Clean chronological start (Mon-Thu when rested, Tue-Fri after working Sunday)
          return a.start - b.start;
        });

        const chosen = candidateWindows[0].winDays;
        state.consecutiveBlockDates = new Set(chosen.map(d => d.dateString));
        if (!state.allConsecutiveBlockDates) state.allConsecutiveBlockDates = new Set();
        chosen.forEach(d => state.allConsecutiveBlockDates.add(d.dateString));
      }
    });

    const dailyFilled = {};
    const dailyFloorFilled = {};
    weekDays.forEach(d => {
      dailyFilled[d.dateString] = { D: {}, N: {} };
      Object.keys(requirements).forEach(r => {
        dailyFilled[d.dateString].D[r] = 0;
        dailyFilled[d.dateString].N[r] = 0;
      });
      dailyFloorFilled[d.dateString] = {
        "Top Floor": {},
        "Ground Floor": {},
        "Lower Ground Floor": {}
      };
    });

    function assignShift(state, dayInfo, shiftType, reqRole) {
      const dStr = dayInfo.dateString;
      state.assignedShifts[dStr] = {
        shift: shiftType,
        status: shiftType,
        coveringRole: reqRole
      };
      state.shiftsThisWeek++;
      state.totalShiftsWorked++;
      state.totalHoursWorked += state.shiftHours;
      dailyFilled[dStr][shiftType][reqRole] = (dailyFilled[dStr][shiftType][reqRole] || 0) + 1;

      if (shiftType === "D" && state.floor && dailyFloorFilled[dStr] && dailyFloorFilled[dStr][state.floor]) {
        const poolKey = getFloorPoolKey(state.floor, reqRole);
        dailyFloorFilled[dStr][state.floor][poolKey] = (dailyFloorFilled[dStr][state.floor][poolKey] || 0) + 1;
      }
    }

    function canTakeShift(state, dayInfo, shiftType, coveredRole, enforceFloorQuota = true) {
      const dStr = dayInfo.dateString;
      if (state.staffType !== shiftType) return false;
      if (state.designation !== coveredRole) return false;
      if (state.assignedShifts[dStr]) return false; // Already assigned or on Leave

      // Strict contract hours enforcement: NO OVERSTAFFING
      if (state.shiftsThisWeek >= state.workShiftsAllowedThisWeek) return false;
      if (state.totalShiftsWorked >= state.totalMonthlyTargetShifts) return false;

      // Hard unavailability check
      if (isUnavailable(state.id, dStr, dayInfo.dayName)) return false;

      // Floor-Wise Quota Enforcement (Change #1 — Option A)
      if (enforceFloorQuota && shiftType === "D" && state.floor && VALID_FLOORS.includes(state.floor) && isFloorManagedRole(coveredRole)) {
        const poolKey = getFloorPoolKey(state.floor, coveredRole);
        const currentFloorCount = (dailyFloorFilled[dStr] && dailyFloorFilled[dStr][state.floor] && dailyFloorFilled[dStr][state.floor][poolKey]) || 0;
        const maxFloorCap = getEffectiveFloorQuotaCap(state.floor, coveredRole, dayInfo);
        if (currentFloorCount >= maxFloorCap) {
          return false;
        }
      }

      // Consecutive days limit (target 4, max 5 for maintenance staff) — includes 7-day lookback into previous period!
      const isMaintenance = Boolean(state.designation && state.designation.toLowerCase().includes("maint"));
      const maxConsecutive = isMaintenance ? 5 : 4;
      const dayIdx = calendarDays.findIndex(d => d.dateString === dStr);
      let consecutive = 1;
      for (let i = dayIdx - 1; i >= -7; i--) {
        const prev = getShiftAtCalendarIdx(state, i);
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = getShiftAtCalendarIdx(state, i);
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }

      // Strictly enforce consecutive working days limit (5 for maintenance, 4 for others)
      if (consecutive > maxConsecutive) return false;

      // Night-to-Day Turnaround Rest (across week boundaries & previous period boundary):
      if (shiftType === "D") {
        const prevAsgn = getShiftAtCalendarIdx(state, dayIdx - 1);
        if (prevAsgn && prevAsgn.shift === "N") {
          return false; // Night-to-Day turnaround rest
        }
      }

      // Night Staff Pre-Training Rest:
      // If employee works Night shift, they cannot work the night before daytime training (T - 1)
      if (shiftType === "N" && dayIdx < calendarDays.length - 1) {
        const nextDay = calendarDays[dayIdx + 1];
        const nextAsgn = state.assignedShifts[nextDay.dateString];
        if (nextAsgn && nextAsgn.status === "TR") {
          return false;
        }
      }

      return true;
    }

    // Helper: Weekly capacity check for roles with days_per_week < 7 (prevents scheduling more than base * days_per_week in a week)
    function getWeeklyRoleCap(reqRole, shiftType) {
      const base = getDailyBaseQuota(reqRole, shiftType);
      if (base <= 0) return 0;
      const maxDays = getRoleDaysPerWeek(reqRole);
      return base * getTargetDaysInWeek(maxDays, weekDays.length);
    }

    function getWeeklyRoleFilled(reqRole, shiftType) {
      let total = 0;
      weekDays.forEach(wd => {
        total += (dailyFilled[wd.dateString][shiftType][reqRole] || 0);
      });
      return total;
    }

    function hasWeeklyRoleCapacity(reqRole, shiftType) {
      const maxDays = getRoleDaysPerWeek(reqRole);
      if (maxDays >= 7) return true;
      return getWeeklyRoleFilled(reqRole, shiftType) < getWeeklyRoleCap(reqRole, shiftType);
    }

    // Helper: Pick candidates iteratively so when a family member is selected, their linked partner is immediately boosted next
    function pickCandidatesIteratively(dayInfo, shiftType, reqRole, reqQuota, filterFn, sortComparator) {
      const dStr = dayInfo.dateString;
      while ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota && hasWeeklyRoleCapacity(reqRole, shiftType)) {
        const eligible = Object.values(empState).filter(st => filterFn(st));
        if (eligible.length === 0) break;
        eligible.sort((a, b) => {
          const famCmp = compareFamilyPriority(a, b, dStr, dayInfo.dayName);
          if (famCmp !== 0) return famCmp;
          return sortComparator(a, b);
        });
        assignShift(eligible[0], dayInfo, shiftType, reqRole);
      }
    }

    // Helper: Check if candidate is working on an adjacent day (yesterday or tomorrow) to form clean consecutive blocks
    function hasAdjacentWorkingShift(st, dayInfo) {
      const dayIdx = calendarDays.findIndex(d => d.dateString === dayInfo.dateString);
      const prev = getShiftAtCalendarIdx(st, dayIdx - 1);
      const next = getShiftAtCalendarIdx(st, dayIdx + 1);
      const prevWork = prev && (prev.shift === "D" || prev.shift === "N") && prev.status !== "TR";
      const nextWork = next && (next.shift === "D" || next.shift === "N") && next.status !== "TR";
      return Boolean(prevWork || nextWork);
    }

    // Helper: Weekday candidate comparator that protects Off-Weekend staff and builds consecutive blocks
    function compareWeekdayCandidates(a, b, wDay) {
      const needA = a.workShiftsAllowedThisWeek - a.shiftsThisWeek;
      const needB = b.workShiftsAllowedThisWeek - b.shiftsThisWeek;

      // Count remaining weekdays in this week from wDay onwards (inclusive)
      const wDayIdxInWeek = weekDays.findIndex(d => d.dateString === wDay.dateString);
      const remainingWeekdaysCount = weekDays.slice(wDayIdxInWeek).filter(d => !d.isWeekend).length;

      // 1. Urgent Off-Weekend protection: if an off-weekend staff member needs all remaining weekdays to fulfill their weekly target, prioritize them first!
      const aUrgentOffWk = (!a.isWeekendWorkingWeek && needA >= remainingWeekdaysCount) ? 1 : 0;
      const bUrgentOffWk = (!b.isWeekendWorkingWeek && needB >= remainingWeekdaysCount) ? 1 : 0;
      if (bUrgentOffWk !== aUrgentOffWk) return bUrgentOffWk - aUrgentOffWk;

      // 2. Prioritize off-weekend cohort on weekdays so they complete their weekly shifts on Mon-Fri without spilling into weekends
      const aOffWk = !a.isWeekendWorkingWeek ? 1 : 0;
      const bOffWk = !b.isWeekendWorkingWeek ? 1 : 0;
      if (bOffWk !== aOffWk && needA === needB) return bOffWk - aOffWk;

      // 3. Higher remaining shifts needed this week
      if (needB !== needA) return needB - needA;

      if (bOffWk !== aOffWk) return bOffWk - aOffWk;

      // 4. Prefer adjacent working shift to keep consecutive working blocks together
      const aAdj = hasAdjacentWorkingShift(a, wDay) ? 1 : 0;
      const bAdj = hasAdjacentWorkingShift(b, wDay) ? 1 : 0;
      if (bAdj !== aAdj) return bAdj - aAdj;

      return a.totalShiftsWorked - b.totalShiftsWorked;
    }

    // Role order sorted by hierarchy rank
    const sortedRoles = Object.keys(requirements).sort((a, b) => getRoleRank(a) - getRoleRank(b));

    // PASS 1: Pattern Workers, Date Preferences & Family Partners First (User Decision #2 + Change #2)
    sortedRoles.forEach(reqRole => {
      ["D", "N"].forEach(shiftType => {
        weekDays.forEach(dayInfo => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, dayInfo, true);
          if (reqQuota <= 0) return;

          const dStr = dayInfo.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;
          if (!hasWeeklyRoleCapacity(reqRole, shiftType)) return;

          pickCandidatesIteratively(
            dayInfo,
            shiftType,
            reqRole,
            reqQuota,
            (st) => {
              if (!canTakeShift(st, dayInfo, shiftType, reqRole)) return false;
              if (isPatternWorkDay(st, dStr) === true) return true;
              if (st.consecutiveBlockDates && st.consecutiveBlockDates.has(dStr)) return true;
              // On weekends, only honor non-pattern positive preferences if it's a specific date or their working weekend
              if (dayInfo.isWeekend && !st.isWeekendWorkingWeek) {
                const hasSpecificDatePref = prefList.some(p =>
                  String(p.employee_id) === String(st.id) && p.preference === "prefer" && p.type === "date" && p.target_date === dStr
                );
                return hasSpecificDatePref;
              }
              if (hasPositivePref(st.id, dStr, dayInfo.dayName)) return true;
              if (hasFamilyWorkingOnDate(st, dStr)) return true;
              if (hasFamilyPositivePrefOnDate(st, dStr, dayInfo.dayName)) return true;
              return false;
            },
            (a, b) => (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek)
          );
        });
      });
    });

    // PASS 2: Weekend Working (Saturday & Sunday paired consecutively for active weekend cohort)
    const satDay = weekDays.find(d => d.dayName === "Saturday");
    const sunDay = weekDays.find(d => d.dayName === "Sunday");
    const weekendDays = [satDay, sunDay].filter(Boolean);

    if (weekendDays.length > 0) {
      sortedRoles.forEach(reqRole => {
        ["D", "N"].forEach(shiftType => {
          [satDay, sunDay].forEach(wDay => {
            if (!wDay) return;
            const reqQuota = getRequiredQuota(reqRole, shiftType, wDay);
            if (reqQuota <= 0) return;

            const dStr = wDay.dateString;
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

            pickCandidatesIteratively(
              wDay,
              shiftType,
              reqRole,
              reqQuota,
              (st) => {
                if (!canTakeShift(st, wDay, shiftType, reqRole)) return false;
                if (st.pattern && !isConsecutiveBlockPattern(st)) return isPatternWorkDay(st, dStr) !== false;
                if (st.consecutiveBlockDates && !st.consecutiveBlockDates.has(dStr)) return false;
                return st.isWeekendWorkingWeek;
              },
              (a, b) => {
                const otherDay = wDay === satDay ? sunDay : satDay;
                const aWorkedOther = otherDay && a.assignedShifts[otherDay.dateString] && a.assignedShifts[otherDay.dateString].shift !== "OFF";
                const bWorkedOther = otherDay && b.assignedShifts[otherDay.dateString] && b.assignedShifts[otherDay.dateString].shift !== "OFF";
                if (bWorkedOther && !aWorkedOther) return 1;
                if (aWorkedOther && !bWorkedOther) return -1;
                if (a.weekendsWorkedCount !== b.weekendsWorkedCount) {
                  return a.weekendsWorkedCount - b.weekendsWorkedCount;
                }
                return (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek);
              }
            );
          });
        });
      });
    }

    // PASS 3 & 4: Weekdays for Staff Needing Shifts (Off-Weekend Staff Prioritized so their Weekends Stay Off)
    // Sub-Pass 4A ensures every weekday (including Wed/Thu/Fri) gets a minimum safe base (never 0) first,
    // and Sub-Pass 4B then fills days all the way to full 100% quota so we keep maximum full green days.
    const weekdaysOnly = weekDays.filter(d => !d.isWeekend);
    sortedRoles.forEach(reqRole => {
      ["D", "N"].forEach(shiftType => {
        // Sub-Pass 4A-0: Complementary Senior Carer Pre-Fill on Ground & Lower Ground Floors
        // Prioritizes weekdays where that floor currently has 0 Staff Nurse so SN & SC don't both pile onto Mon-Thu and leave Friday empty.
        if (shiftType === "D" && reqRole === "Senior Carer") {
          NON_TOP_SN_SC_FLOORS.forEach(floorName => {
            if (!isFloorRequiringSnOrSc(floorName)) return;
            const daysWithoutSn = weekdaysOnly.filter(wDay => {
              const dStr = wDay.dateString;
              const snCount = Object.values(empState).filter(s => {
                const a = s.assignedShifts[dStr];
                return a && a.shift === "D" && a.status !== "TR" && (s.floor || "") === floorName &&
                  (a.coveringRole || s.designation) === "Staff Nurse";
              }).length;
              return snCount === 0;
            });

            daysWithoutSn.forEach(wDay => {
              const reqQuota = getRequiredQuota("Senior Carer", "D", wDay);
              if (reqQuota <= 0) return;
              const dStr = wDay.dateString;
              const fQuota = getFloorPoolQuota(floorName, "Senior Carer", wDay);
              if (fQuota <= 0) return;
              const poolKey = getFloorPoolKey(floorName, "Senior Carer");
              const curFloorSc = (dailyFloorFilled[dStr] && dailyFloorFilled[dStr][floorName] && dailyFloorFilled[dStr][floorName][poolKey]) || 0;
              if (curFloorSc >= 1) return;
              if ((dailyFilled[dStr].D["Senior Carer"] || 0) >= reqQuota) return;
              if (!hasWeeklyRoleCapacity("Senior Carer", "D")) return;

              const eligible = Object.values(empState).filter(st => {
                if ((st.floor || "") !== floorName) return false;
                if (st.designation !== "Senior Carer") return false;
                if (st.consecutiveBlockDates && !st.consecutiveBlockDates.has(dStr)) return false;
                return canTakeShift(st, wDay, "D", "Senior Carer");
              });
              if (eligible.length > 0) {
                eligible.sort((a, b) => {
                  const famCmp = compareFamilyPriority(a, b, dStr, wDay.dayName);
                  if (famCmp !== 0) return famCmp;
                  return compareWeekdayCandidates(a, b, wDay);
                });
                assignShift(eligible[0], wDay, "D", "Senior Carer");
              }
            });
          });
        }

        // Sub-Pass 4A: Minimum Safe Base across all weekdays (prevents 0-allotted days on Wed/Thu/Fri)
        weekdaysOnly.forEach(wDay => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, wDay);
          if (reqQuota <= 0) return;
          const dStr = wDay.dateString;
          const safeBaseQuota = reqQuota >= 4 ? Math.ceil(reqQuota * 0.6) : (reqQuota >= 2 ? Math.ceil(reqQuota * 0.5) : 1);

          // For floor-managed Day roles, ensure each populated floor gets its minimum base on wDay first
          if (shiftType === "D" && isFloorManagedRole(reqRole)) {
            VALID_FLOORS.forEach(floorName => {
              const fQuota = getFloorPoolQuota(floorName, reqRole, wDay);
              if (fQuota <= 0) return;
              const fSafeBase = fQuota >= 4 ? Math.ceil(fQuota * 0.6) : (fQuota >= 2 ? Math.ceil(fQuota * 0.5) : 1);
              const poolKey = getFloorPoolKey(floorName, reqRole);
              const poolRoles = getFloorPoolRoles(floorName, reqRole);

              while (
                ((dailyFloorFilled[dStr] && dailyFloorFilled[dStr][floorName] && dailyFloorFilled[dStr][floorName][poolKey]) || 0) < fSafeBase
              ) {
                const eligible = Object.values(empState).filter(st => {
                  if ((st.floor || "") !== floorName) return false;
                  if (!poolRoles.includes(st.designation)) return false;
                  const roleReq = getRequiredQuota(st.designation, shiftType, wDay);
                  if ((dailyFilled[dStr][shiftType][st.designation] || 0) >= roleReq) return false;
                  if (!hasWeeklyRoleCapacity(st.designation, shiftType)) return false;
                  if (st.consecutiveBlockDates && !st.consecutiveBlockDates.has(dStr)) return false;
                  return canTakeShift(st, wDay, shiftType, st.designation);
                });
                if (eligible.length === 0) break;
                eligible.sort((a, b) => {
                  const famCmp = compareFamilyPriority(a, b, dStr, wDay.dayName);
                  if (famCmp !== 0) return famCmp;
                  return compareWeekdayCandidates(a, b, wDay);
                });
                assignShift(eligible[0], wDay, shiftType, eligible[0].designation);
              }
            });
          }

          if ((dailyFilled[dStr][shiftType][reqRole] || 0) < safeBaseQuota) {
            pickCandidatesIteratively(
              wDay,
              shiftType,
              reqRole,
              safeBaseQuota,
              (st) => {
                if (st.consecutiveBlockDates && !st.consecutiveBlockDates.has(dStr)) return false;
                return canTakeShift(st, wDay, shiftType, reqRole);
              },
              (a, b) => compareWeekdayCandidates(a, b, wDay)
            );
          }
        });

        // Sub-Pass 4B: Full Quota Completion (fills days to 100% reqQuota)
        weekdaysOnly.forEach(wDay => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, wDay);
          if (reqQuota <= 0) return;
          const dStr = wDay.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

          pickCandidatesIteratively(
            wDay,
            shiftType,
            reqRole,
            reqQuota,
            (st) => {
              if (st.consecutiveBlockDates && !st.consecutiveBlockDates.has(dStr)) return false;
              return canTakeShift(st, wDay, shiftType, reqRole);
            },
            (a, b) => compareWeekdayCandidates(a, b, wDay)
          );
        });
      });
    });

    // PASS 5: Role Hierarchy Substitutions (Strictly without exceeding contract hours or floor quotas)
    sortedRoles.forEach(reqRole => {
      ["D", "N"].forEach(shiftType => {
        weekDays.forEach(dayInfo => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, dayInfo);
          if (reqQuota <= 0) return;

          const dStr = dayInfo.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;
          if (!hasWeeklyRoleCapacity(reqRole, shiftType)) return;

          const substitutes = roleHierarchyMap[reqRole] || [reqRole];
          for (let sIdx = 1; sIdx < substitutes.length; sIdx++) {
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota || !hasWeeklyRoleCapacity(reqRole, shiftType)) break;
            const subRole = substitutes[sIdx];

            const candidates = Object.values(empState).filter(st => {
              if (!canTakeShift(st, dayInfo, shiftType, subRole)) return false;
              // Respect Fair Weekend Rule during substitutions
              if (dayInfo.isWeekend && !st.isWeekendWorkingWeek) return false;
              return true;
            }).sort((a, b) => {
              const famCmp = compareFamilyPriority(a, b, dStr, dayInfo.dayName);
              if (famCmp !== 0) return famCmp;
              return (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek);
            });

            candidates.forEach(chosen => {
              if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota && hasWeeklyRoleCapacity(reqRole, shiftType)) {
                assignShift(chosen, dayInfo, shiftType, reqRole);
                warnings.push({
                  type: "substitution",
                  date: dStr,
                  day: dayInfo.dayName,
                  message: `${chosen.name} (${chosen.designation}) substituted to cover ${reqRole} on ${dayInfo.dayName} (${dStr}).`
                });
              }
            });
          }
        });
      });
    });

    // PASS 5B: Within-Week Contract Fulfillment (Strictly Enforcing Fair Weekend Rule & Weekly Caps)
    // When a floor has more contracted staff shifts in a week than its minimum floor quota (e.g., 9 Carers on Top Floor),
    // allocate each employee's remaining weekly contracted shifts within THIS week on their eligible days (Mon-Fri for off-weekend
    // staff; balanced across lowest role-count days for weekend cohort staff) so they never get dumped onto off-weekends later.
    Object.values(empState).forEach(st => {
      if (st.shiftsThisWeek >= st.workShiftsAllowedThisWeek) return;
      if (st.totalShiftsWorked >= st.totalMonthlyTargetShifts) return;

      const shiftType = st.staffType;
      const reqRole = st.designation;

      while (st.shiftsThisWeek < st.workShiftsAllowedThisWeek && st.totalShiftsWorked < st.totalMonthlyTargetShifts) {
        // First try days that strictly respect the Fair Weekend Rule (weekdays only if !isWeekendWorkingWeek)
        let eligibleDays = weekDays.filter(d => {
          if (d.isWeekend && !st.isWeekendWorkingWeek && isPatternWorkDay(st, d.dateString) !== true) return false;
          return canTakeShift(st, d, shiftType, reqRole, false);
        });

        // Fallback to any legal day in the week only if no weekday is legally available (e.g. mid-week leave/training)
        if (eligibleDays.length === 0) {
          eligibleDays = weekDays.filter(d => canTakeShift(st, d, shiftType, reqRole, false));
        }
        if (eligibleDays.length === 0) break;

        eligibleDays.sort((dayA, dayB) => {
          const dStrA = dayA.dateString;
          const dStrB = dayB.dateString;

          // 0. Consecutive-Block Pattern (N Working / 0 Rest): finish designated consecutive block first
          if (st.consecutiveBlockDates) {
            const inBlockA = st.consecutiveBlockDates.has(dStrA) ? 1 : 0;
            const inBlockB = st.consecutiveBlockDates.has(dStrB) ? 1 : 0;
            if (inBlockB !== inBlockA) return inBlockB - inBlockA;
          }

          // 1. If st is on their working weekend and already worked one weekend day, pair the other weekend day first
          if (st.isWeekendWorkingWeek) {
            const aIsPairedWk = (dayA === satDay && sunDay && st.assignedShifts[sunDay.dateString] && st.assignedShifts[sunDay.dateString].shift !== "OFF") ||
                                (dayA === sunDay && satDay && st.assignedShifts[satDay.dateString] && st.assignedShifts[satDay.dateString].shift !== "OFF") ? 1 : 0;
            const bIsPairedWk = (dayB === satDay && sunDay && st.assignedShifts[sunDay.dateString] && st.assignedShifts[sunDay.dateString].shift !== "OFF") ||
                                (dayB === sunDay && satDay && st.assignedShifts[satDay.dateString] && st.assignedShifts[satDay.dateString].shift !== "OFF") ? 1 : 0;
            if (bIsPairedWk !== aIsPairedWk) return bIsPairedWk - aIsPairedWk;
          }

          // 2. Prefer days where whole-home role quota is still below required quota
          const reqA = getRequiredQuota(reqRole, shiftType, dayA);
          const reqB = getRequiredQuota(reqRole, shiftType, dayB);
          const underA = ((dailyFilled[dStrA][shiftType][reqRole] || 0) < reqA) ? 1 : 0;
          const underB = ((dailyFilled[dStrB][shiftType][reqRole] || 0) < reqB) ? 1 : 0;
          if (underB !== underA) return underB - underA;

          // 3. Family member working on the same date
          const famA = hasFamilyWorkingOnDate(st, dStrA) ? 1 : 0;
          const famB = hasFamilyWorkingOnDate(st, dStrB) ? 1 : 0;
          if (famB !== famA) return famB - famA;

          // 4. Prefer weekdays over weekends when filling extra floor capacity so weekends aren't over-allocated
          if (dayA.isWeekend !== dayB.isWeekend) {
            return dayA.isWeekend ? 1 : -1;
          }

          // 5. Lowest current floor count for this role pool
          if (shiftType === "D" && st.floor && VALID_FLOORS.includes(st.floor)) {
            const poolKey = getFloorPoolKey(st.floor, reqRole);
            const fCountA = (dailyFloorFilled[dStrA] && dailyFloorFilled[dStrA][st.floor] && dailyFloorFilled[dStrA][st.floor][poolKey]) || 0;
            const fCountB = (dailyFloorFilled[dStrB] && dailyFloorFilled[dStrB][st.floor] && dailyFloorFilled[dStrB][st.floor][poolKey]) || 0;
            if (fCountA !== fCountB) return fCountA - fCountB;
          }

          // 6. Lowest whole-home count for this specific role
          const roleCountA = dailyFilled[dStrA][shiftType][reqRole] || 0;
          const roleCountB = dailyFilled[dStrB][shiftType][reqRole] || 0;
          if (roleCountA !== roleCountB) return roleCountA - roleCountB;

          // 7. Prefer adjacent working day for clean consecutive shift blocks
          const adjA = hasAdjacentWorkingShift(st, dayA) ? 1 : 0;
          const adjB = hasAdjacentWorkingShift(st, dayB) ? 1 : 0;
          if (adjB !== adjA) return adjB - adjA;

          return 0;
        });

        assignShift(st, eligibleDays[0], shiftType, reqRole);
      }
    });

    // Update weekendsWorkedCount for fairness tracking across weeks
    Object.values(empState).forEach(st => {
      const workedWk = weekendDays.some(wd => st.assignedShifts[wd.dateString] && (st.assignedShifts[wd.dateString].shift === "D" || st.assignedShifts[wd.dateString].shift === "N"));
      if (workedWk) st.weekendsWorkedCount++;
    });

    // PASS 6: Mark Unassigned Days as OFF
    weekDays.forEach(dayInfo => {
      const dStr = dayInfo.dateString;
      employees.forEach(emp => {
        const st = empState[emp.id];
        if (!st.assignedShifts[dStr]) {
          st.assignedShifts[dStr] = { shift: "OFF", status: "OFF", coveringRole: "" };
        }
      });
    });
  });

  // Helper to check if a calendar date falls on an employee's designated working weekend
  function isDateInEmployeeWeekendCohort(st, dateString) {
    const wIdx = weeks.findIndex(wk => wk.some(d => d.dateString === dateString));
    if (wIdx === -1) return false;
    return (wIdx % 2 === 0 && st.weekendCohort === "A") || (wIdx % 2 === 1 && st.weekendCohort === "B");
  }

  // Helper to check how many shifts an employee already has in the week containing dateString
  function getShiftsWorkedInWeekOfDate(st, dateString) {
    const wIdx = weeks.findIndex(wk => wk.some(d => d.dateString === dateString));
    if (wIdx === -1) return 0;
    let cnt = 0;
    weeks[wIdx].forEach(d => {
      const a = st.assignedShifts[d.dateString];
      if (a && (a.shift === "D" || a.shift === "N" || isLeaveStatus(a.status))) cnt++;
    });
    return cnt;
  }

  function getMaxAllowedShiftsInWeekOfDate(st, dateString) {
    const wIdx = weeks.findIndex(wk => wk.some(d => d.dateString === dateString));
    if (wIdx === -1) return 4;
    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const baseTarget = st.weeklyTargets[wIdx] || 4;
    return Math.min(isMaintenance ? 5 : 4, Math.max(baseTarget, 4));
  }

  // PASS 7A: Monthly Contract Hours Equalization Sweep (Strict Quota / Zero Overstaffing + Fair Weekend Protection)
  Object.values(empState).forEach(st => {
    let empLeaveCount = 0;
    calendarDays.forEach(d => {
      const a = st.assignedShifts[d.dateString];
      if (a && (isLeaveStatus(a.status) || a.isLeave)) empLeaveCount++;
    });
    const netTargetShifts = Math.max(0, st.totalMonthlyTargetShifts - empLeaveCount);

    if (st.totalShiftsWorked >= netTargetShifts) return;

    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const maxConsecutive = isMaintenance ? 5 : 4;

    // Sort candidate days in Pass 7A: 1) Non-off-weekend days first, 2) Family partner working, 3) Chronological
    const orderedCalendarDays = calendarDays.map((dayInfo, dayIdx) => ({ dayInfo, dayIdx })).sort((a, b) => {
      const aOffWkPenalty = (a.dayInfo.isWeekend && !isDateInEmployeeWeekendCohort(st, a.dayInfo.dateString)) ? 1 : 0;
      const bOffWkPenalty = (b.dayInfo.isWeekend && !isDateInEmployeeWeekendCohort(st, b.dayInfo.dateString)) ? 1 : 0;
      if (aOffWkPenalty !== bOffWkPenalty) return aOffWkPenalty - bOffWkPenalty;

      const aFam = hasFamilyWorkingOnDate(st, a.dayInfo.dateString) ? 1 : 0;
      const bFam = hasFamilyWorkingOnDate(st, b.dayInfo.dateString) ? 1 : 0;
      if (bFam !== aFam) return bFam - aFam;
      return a.dayIdx - b.dayIdx;
    });

    orderedCalendarDays.forEach(({ dayInfo, dayIdx }) => {
      if (st.totalShiftsWorked >= netTargetShifts) return;
      const dStr = dayInfo.dateString;
      const shiftType = st.staffType;
      const reqRole = st.designation;
      const reqQuota = getRequiredQuota(reqRole, shiftType, dayInfo);

      // Protect Fair Weekend Rule & Weekly Shift Cap
      if (dayInfo.isWeekend && !isDateInEmployeeWeekendCohort(st, dStr) && isPatternWorkDay(st, dStr) !== true) return;
      if (getShiftsWorkedInWeekOfDate(st, dStr) >= getMaxAllowedShiftsInWeekOfDate(st, dStr)) return;

      // Check current filled on this day for this role
      const currentFilled = Object.values(empState).filter(s => {
        const asgn = s.assignedShifts[dStr];
        return asgn && asgn.shift === shiftType && asgn.status !== "TR" && (asgn.coveringRole || s.designation) === reqRole;
      }).length;

      // NO OVERSTAFFING: Only fill if current filled < required quota!
      if (currentFilled >= reqQuota) return;

      // Also enforce weekly role cap for < 7 days/week roles in Pass 7A
      const rawMaxDays = getRoleDaysPerWeek(reqRole);
      if (rawMaxDays < 7) {
        const wkForDay = weeks.find(wk => wk.some(wd => wd.dateString === dStr));
        if (wkForDay) {
          const wkCap = getDailyBaseQuota(reqRole, shiftType) * getTargetDaysInWeek(rawMaxDays, wkForDay.length);
          let wkFilled = 0;
          wkForDay.forEach(wd => {
            wkFilled += Object.values(empState).filter(s => {
              const a = s.assignedShifts[wd.dateString];
              return a && a.shift === shiftType && a.status !== "TR" && (a.coveringRole || s.designation) === reqRole;
            }).length;
          });
          if (wkFilled >= wkCap) return;
        }
      }

      // Also check floor quota in Pass 7A so we fill genuinely under-quota floors first
      if (shiftType === "D" && st.floor && VALID_FLOORS.includes(st.floor) && isFloorManagedRole(reqRole)) {
        const poolRoles = getFloorPoolRoles(st.floor, reqRole);
        const currentFloorFilled = Object.values(empState).filter(s => {
          const asgn = s.assignedShifts[dStr];
          return asgn && asgn.shift === "D" && asgn.status !== "TR" && (s.floor || "") === st.floor &&
            (poolRoles.includes(asgn.coveringRole) || poolRoles.includes(s.designation));
        }).length;
        const maxFloorCap = getEffectiveFloorQuotaCap(st.floor, reqRole, dayInfo);
        if (currentFloorFilled >= maxFloorCap) return;
      }

      // Can this staff take this shift?
      const existing = st.assignedShifts[dStr];
      if (existing) {
        if (isLeaveStatus(existing.status) || existing.leaveProtected || existing.isNightTrainingRest || existing.shift !== "OFF") {
          return;
        }
      }
      if (isUnavailable(st.id, dStr, dayInfo.dayName)) return;

      // Check consecutive days (max 5 for maintenance, 4 for others) including 7-day previous period lookback
      let consecutive = 1;
      for (let i = dayIdx - 1; i >= -7; i--) {
        const prev = getShiftAtCalendarIdx(st, i);
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = getShiftAtCalendarIdx(st, i);
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }
      if (consecutive > maxConsecutive) return;

      // Turnaround Rest in Pass 7A (including across previous period boundary):
      if (shiftType === "D") {
        const prev = getShiftAtCalendarIdx(st, dayIdx - 1);
        if (prev && prev.shift === "N") return;
      }

      // Night Staff Pre-Training Rest in Pass 7A:
      if (shiftType === "N" && dayIdx < calendarDays.length - 1) {
        const nextDay = calendarDays[dayIdx + 1];
        const nextAsgn = st.assignedShifts[nextDay.dateString];
        if (nextAsgn && nextAsgn.status === "TR") return;
      }

      // Assign!
      st.assignedShifts[dStr] = {
        shift: shiftType,
        status: shiftType,
        coveringRole: reqRole
      };
      st.totalShiftsWorked++;
      st.totalHoursWorked += st.shiftHours;
    });
  });

  // PASS 7B: Smart Overstaffing Fallback (User Rule + Option A Contract Hours Guarantee + Fair Weekend Protection)
  Object.values(empState).forEach(st => {
    let empLeaveCount = 0;
    calendarDays.forEach(d => {
      const a = st.assignedShifts[d.dateString];
      if (a && (isLeaveStatus(a.status) || a.isLeave)) empLeaveCount++;
    });
    const netTargetShifts = Math.max(0, st.totalMonthlyTargetShifts - empLeaveCount);

    if (st.totalShiftsWorked >= netTargetShifts) return;

    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const maxConsecutive = isMaintenance ? 5 : 4;
    const shiftType = st.staffType;
    const reqRole = st.designation;

    // Collect candidate days that satisfy all safety, rest, weekly cap, and Fair Weekend rules
    const candidateDays = [];
    calendarDays.forEach((dayInfo, dayIdx) => {
      const dStr = dayInfo.dateString;
      // Never dump fallback shifts onto an employee's off-weekend!
      if (dayInfo.isWeekend && !isDateInEmployeeWeekendCohort(st, dStr) && isPatternWorkDay(st, dStr) !== true) {
        return;
      }
      if (getShiftsWorkedInWeekOfDate(st, dStr) >= getMaxAllowedShiftsInWeekOfDate(st, dStr)) {
        return;
      }

      const existing = st.assignedShifts[dStr];
      if (existing) {
        if (isLeaveStatus(existing.status) || existing.leaveProtected || existing.isNightTrainingRest || existing.shift !== "OFF") {
          return;
        }
      }
      if (isUnavailable(st.id, dStr, dayInfo.dayName)) return;

      let consecutive = 1;
      for (let i = dayIdx - 1; i >= -7; i--) {
        const prev = getShiftAtCalendarIdx(st, i);
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = getShiftAtCalendarIdx(st, i);
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }
      if (consecutive > maxConsecutive) return;

      if (shiftType === "D") {
        const prev = getShiftAtCalendarIdx(st, dayIdx - 1);
        if (prev && prev.shift === "N") return;
      }

      if (shiftType === "N" && dayIdx < calendarDays.length - 1) {
        const nextDay = calendarDays[dayIdx + 1];
        const nextAsgn = st.assignedShifts[nextDay.dateString];
        if (nextAsgn && nextAsgn.status === "TR") return;
      }

      // Count staff of the SAME role on duty on this floor and across the building (avoids weekend bias from 5-day roles)
      const floorStaffOnDay = st.floor ? Object.values(empState).filter(s => {
        const asgn = s.assignedShifts[dStr];
        return asgn && asgn.shift === shiftType && asgn.status !== "TR" && (s.floor || "") === st.floor && s.designation === reqRole;
      }).length : 0;

      const roleStaffOnDay = Object.values(empState).filter(s => {
        const asgn = s.assignedShifts[dStr];
        return asgn && asgn.shift === shiftType && asgn.status !== "TR" && s.designation === reqRole;
      }).length;

      const famWorking = hasFamilyWorkingOnDate(st, dStr) ? 1 : 0;
      const isWkend = dayInfo.isWeekend ? 1 : 0;

      candidateDays.push({ dayInfo, dayIdx, floorStaffOnDay, roleStaffOnDay, famWorking, isWkend });
    });

    // Prioritize: 1) Family member working on day, 2) Weekdays before weekends, 3) Lowest floor role count, 4) Lowest role count
    candidateDays.sort((a, b) => {
      if (b.famWorking !== a.famWorking) return b.famWorking - a.famWorking;
      if (a.isWkend !== b.isWkend) return a.isWkend - b.isWkend;
      if (a.floorStaffOnDay !== b.floorStaffOnDay) return a.floorStaffOnDay - b.floorStaffOnDay;
      return a.roleStaffOnDay - b.roleStaffOnDay;
    });

    for (const cand of candidateDays) {
      if (st.totalShiftsWorked >= netTargetShifts) break;
      const dStr = cand.dayInfo.dateString;
      const dayIdx = cand.dayIdx;
      if (getShiftsWorkedInWeekOfDate(st, dStr) >= getMaxAllowedShiftsInWeekOfDate(st, dStr)) continue;

      // Re-verify consecutive streak doesn't exceed limit (including 7-day lookback)
      let consecutive = 1;
      for (let i = dayIdx - 1; i >= -7; i--) {
        const prev = getShiftAtCalendarIdx(st, i);
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = getShiftAtCalendarIdx(st, i);
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }
      if (consecutive > maxConsecutive) continue;

      st.assignedShifts[dStr] = {
        shift: shiftType,
        status: shiftType,
        coveringRole: reqRole,
        isContractFulfillment: true
      };
      st.totalShiftsWorked++;
      st.totalHoursWorked += st.shiftHours;
    }
  });

  // PASS 7C: Targeted "No-Zero-Day" Rescue Pass (Zero Rule Overlap)
  // If any required role or floor role pool has 0 staff allotted on a day in a week while other days in the same week
  // have surplus/full staffing, move 1–2 legal shifts from the fullest day(s) in that week into the 0 day
  // while strictly enforcing 100% of existing rules (consecutive days, turnaround rest, leave, preferences, patterns, weekend rule, family links).
  function canLegallyMoveShiftWithinWeek(st, donorDayInfo, targetDayInfo, shiftType) {
    const donorStr = donorDayInfo.dateString;
    const targetStr = targetDayInfo.dateString;
    if (donorStr === targetStr) return false;
    if (st.staffType !== shiftType) return false;

    const donorAsgn = st.assignedShifts[donorStr];
    if (!donorAsgn || donorAsgn.shift !== shiftType || donorAsgn.status !== shiftType) return false;

    const targetAsgn = st.assignedShifts[targetStr];
    if (targetAsgn && (isLeaveStatus(targetAsgn.status) || targetAsgn.isLeave || targetAsgn.leaveProtected || targetAsgn.isNightTrainingRest || targetAsgn.shift !== "OFF")) {
      return false;
    }

    // Hard unavailability or positive preference check
    if (isUnavailable(st.id, targetStr, targetDayInfo.dayName)) return false;
    if (hasPositivePref(st.id, donorStr, donorDayInfo.dayName)) return false;

    // Repeating pattern & consecutive-block check: never break a pattern work/off day or consecutive block
    if (st.pattern) {
      if (isConsecutiveBlockPattern(st)) {
        if (st.allConsecutiveBlockDates && st.allConsecutiveBlockDates.has(donorStr)) return false;
      } else {
        if (isPatternWorkDay(st, donorStr) === true) return false;
        if (isPatternWorkDay(st, targetStr) === false) return false;
      }
    }

    // Weekend rule check: do not pull weekend workers off their weekend onto a weekday, or force non-weekend cohort onto a weekend
    if (donorDayInfo.isWeekend && !targetDayInfo.isWeekend) return false;
    if (!donorDayInfo.isWeekend && targetDayInfo.isWeekend && !st.isWeekendWorkingWeek) return false;

    // Family Members Together check: do not split a family pair if their partner is working on donorDay
    if (st.familyPeers && st.familyPeers.length > 0) {
      if (hasFamilyWorkingOnDate(st, donorStr) && !hasFamilyWorkingOnDate(st, targetStr)) {
        return false;
      }
      if (hasFamilyOffOrUnavailableOnDate(st, targetStr, targetDayInfo.dayName)) {
        return false;
      }
    }

    // Temporarily simulate the swap to verify consecutive streak & turnaround rest across the entire calendar + 7-day lookback
    const savedDonor = st.assignedShifts[donorStr];
    const savedTarget = st.assignedShifts[targetStr] || { shift: "OFF", status: "OFF", coveringRole: "" };

    st.assignedShifts[donorStr] = { shift: "OFF", status: "OFF", coveringRole: "" };
    st.assignedShifts[targetStr] = {
      shift: shiftType,
      status: shiftType,
      coveringRole: savedDonor.coveringRole || st.designation,
      isContractFulfillment: Boolean(savedDonor.isContractFulfillment)
    };

    let isLegal = true;
    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const maxConsecutive = isMaintenance ? 5 : 4;
    const targetIdx = calendarDays.findIndex(d => d.dateString === targetStr);

    // 1. Consecutive streak check around targetIdx (including 7-day lookback)
    let consecutive = 1;
    for (let i = targetIdx - 1; i >= -7; i--) {
      const prev = getShiftAtCalendarIdx(st, i);
      if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
      else break;
    }
    for (let i = targetIdx + 1; i < calendarDays.length; i++) {
      const next = getShiftAtCalendarIdx(st, i);
      if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
      else break;
    }
    if (consecutive > maxConsecutive) isLegal = false;

    // 2. Turnaround rest & pre-training night rest check
    if (isLegal && shiftType === "D") {
      const prev = getShiftAtCalendarIdx(st, targetIdx - 1);
      if (prev && prev.shift === "N") isLegal = false;
    }
    if (isLegal && shiftType === "N" && targetIdx < calendarDays.length - 1) {
      const nextAsgn = st.assignedShifts[calendarDays[targetIdx + 1].dateString];
      if (nextAsgn && (nextAsgn.shift === "D" || nextAsgn.status === "TR")) isLegal = false;
    }

    // Restore original state after simulation
    st.assignedShifts[donorStr] = savedDonor;
    st.assignedShifts[targetStr] = savedTarget;

    return isLegal;
  }

  function executeShiftMoveWithinWeek(st, donorDayInfo, targetDayInfo, shiftType) {
    const donorStr = donorDayInfo.dateString;
    const targetStr = targetDayInfo.dateString;
    const savedDonor = st.assignedShifts[donorStr];
    st.assignedShifts[donorStr] = { shift: "OFF", status: "OFF", coveringRole: "" };
    st.assignedShifts[targetStr] = {
      shift: shiftType,
      status: shiftType,
      coveringRole: (savedDonor && savedDonor.coveringRole) || st.designation,
      isContractFulfillment: Boolean(savedDonor && savedDonor.isContractFulfillment)
    };
  }

  weeks.forEach(weekDays => {
    // Part A: Rescue any 0-allotted day on Floor-Wise Day Role Pools (Top Floor, Ground Floor, Lower Ground Floor)
    VALID_FLOORS.forEach(floorName => {
      const checkedPoolKeys = new Set();
      Object.keys(requirements).forEach(roleName => {
        const poolKey = getFloorPoolKey(floorName, roleName);
        if (checkedPoolKeys.has(poolKey)) return;
        checkedPoolKeys.add(poolKey);

        const poolRoles = getFloorPoolRoles(floorName, roleName);
        const countFloorPoolOnDay = (dStr) => Object.values(empState).filter(s => {
          const asgn = s.assignedShifts[dStr];
          return asgn && asgn.shift === "D" && asgn.status !== "TR" && (s.floor || "") === floorName &&
            (poolRoles.includes(asgn.coveringRole) || poolRoles.includes(s.designation));
        }).length;

        weekDays.forEach(zeroDay => {
          const fQuota = getFloorPoolQuota(floorName, roleName, zeroDay);
          if (fQuota <= 0) return;
          const initialCount = countFloorPoolOnDay(zeroDay.dateString);
          const minAcceptable = fQuota >= 4 ? 2 : 1;
          if (initialCount >= minAcceptable) return; // Trigger rescue when 0 (or 1 when quota >= 4)

          const targetRescue = minAcceptable;
          for (let step = 0; step < targetRescue; step++) {
            const curZeroCount = countFloorPoolOnDay(zeroDay.dateString);
            if (curZeroCount >= targetRescue) break;

            // Find donor days in the same week that have at least 2 staff and at least (curZeroCount + 2) staff
            const donorDays = weekDays
              .filter(d => d.dateString !== zeroDay.dateString && countFloorPoolOnDay(d.dateString) >= Math.max(2, curZeroCount + 2))
              .sort((a, b) => countFloorPoolOnDay(b.dateString) - countFloorPoolOnDay(a.dateString));

            let moved = false;
            for (const donorDay of donorDays) {
              const donorCandidates = Object.values(empState).filter(s =>
                s.staffType === "D" &&
                (s.floor || "") === floorName &&
                poolRoles.includes(s.designation) &&
                canLegallyMoveShiftWithinWeek(s, donorDay, zeroDay, "D")
              );
              if (donorCandidates.length > 0) {
                executeShiftMoveWithinWeek(donorCandidates[0], donorDay, zeroDay, "D");
                moved = true;
                break;
              }
            }
            if (!moved) break;
          }
        });
      });
    });

    // Part B: Rescue any 0-allotted day on Whole-Home Roles (Day & Night)
    Object.keys(requirements).forEach(roleName => {
      ["D", "N"].forEach(shiftType => {
        const countRoleOnDay = (dStr) => Object.values(empState).filter(s => {
          const asgn = s.assignedShifts[dStr];
          return asgn && asgn.shift === shiftType && asgn.status !== "TR" &&
            (asgn.coveringRole || s.designation) === roleName;
        }).length;

        const rawMaxDays = getRoleDaysPerWeek(roleName);
        const targetActiveDays = getTargetDaysInWeek(rawMaxDays, weekDays.length);

        weekDays.forEach(zeroDay => {
          const reqQuota = getRequiredQuota(roleName, shiftType, zeroDay);
          if (reqQuota <= 0) return;
          // For flexible < 7 days/week roles, skip rescuing a 0-day if the role already worked its target days this week
          if (rawMaxDays < 7) {
            const workedDaysInWk = weekDays.filter(wd => countRoleOnDay(wd.dateString) > 0).length;
            if (workedDaysInWk >= targetActiveDays) return;
          }
          const initialCount = countRoleOnDay(zeroDay.dateString);
          const minAcceptable = reqQuota >= 4 ? 2 : 1;
          if (initialCount >= minAcceptable) return;

          const targetRescue = minAcceptable;
          for (let step = 0; step < targetRescue; step++) {
            const curZeroCount = countRoleOnDay(zeroDay.dateString);
            if (curZeroCount >= targetRescue) break;

            const donorDays = weekDays
              .filter(d => d.dateString !== zeroDay.dateString && countRoleOnDay(d.dateString) >= Math.max(2, curZeroCount + 2))
              .sort((a, b) => countRoleOnDay(b.dateString) - countRoleOnDay(a.dateString));

            let moved = false;
            for (const donorDay of donorDays) {
              const donorCandidates = Object.values(empState).filter(s => {
                if (s.staffType !== shiftType || s.designation !== roleName) return false;
                if (!canLegallyMoveShiftWithinWeek(s, donorDay, zeroDay, shiftType)) return false;
                // Ensure donating doesn't leave the employee's floor with 0 on donorDay
                if (shiftType === "D" && s.floor && VALID_FLOORS.includes(s.floor) && isFloorManagedRole(roleName)) {
                  const poolRoles = getFloorPoolRoles(s.floor, roleName);
                  const floorDonorCount = Object.values(empState).filter(other => {
                    const a = other.assignedShifts[donorDay.dateString];
                    return a && a.shift === "D" && a.status !== "TR" && (other.floor || "") === s.floor &&
                      (poolRoles.includes(a.coveringRole) || poolRoles.includes(other.designation));
                  }).length;
                  if (floorDonorCount <= 1) return false;
                }
                return true;
              });

              if (donorCandidates.length > 0) {
                executeShiftMoveWithinWeek(donorCandidates[0], donorDay, zeroDay, shiftType);
                moved = true;
                break;
              }
            }
            if (!moved) break;
          }
        });
      });
    });

    // Part C: Non-Top Floor Clinical/Senior Daily Safeguard (Ground Floor & Lower Ground Floor)
    // Guarantees at least 1 Staff Nurse OR Senior Carer every day by legally moving 1 shift from a same-week day
    // that has BOTH Staff Nurse and Senior Carer (combined >= 2) onto any day that has NEITHER (combined === 0).
    NON_TOP_SN_SC_FLOORS.forEach(floorName => {
      if (!isFloorRequiringSnOrSc(floorName)) return;

      const countSnScOnFloor = (dStr) => Object.values(empState).filter(s => {
        const asgn = s.assignedShifts[dStr];
        if (!asgn || asgn.shift !== "D" || asgn.status === "TR") return false;
        if ((s.floor || "") !== floorName) return false;
        const effRole = asgn.coveringRole || s.designation;
        return effRole === "Staff Nurse" || effRole === "Senior Carer";
      }).length;

      weekDays.forEach(zeroDay => {
        if (countSnScOnFloor(zeroDay.dateString) > 0) return;

        // Donor days in the same week that have BOTH SN + SC (combined >= 2) so donating 1 still leaves >= 1
        const donorDays = weekDays
          .filter(d => d.dateString !== zeroDay.dateString && countSnScOnFloor(d.dateString) >= 2)
          .sort((a, b) => countSnScOnFloor(b.dateString) - countSnScOnFloor(a.dateString));

        let rescued = false;
        for (const donorDay of donorDays) {
          // Prefer moving Senior Carer first (keeps Staff Nurse in place), then Staff Nurse if needed
          const donorCandidates = Object.values(empState)
            .filter(s =>
              s.staffType === "D" &&
              (s.floor || "") === floorName &&
              (s.designation === "Senior Carer" || s.designation === "Staff Nurse") &&
              canLegallyMoveShiftWithinWeek(s, donorDay, zeroDay, "D")
            )
            .sort((a, b) => {
              const aIsSc = a.designation === "Senior Carer" ? 0 : 1;
              const bIsSc = b.designation === "Senior Carer" ? 0 : 1;
              return aIsSc - bIsSc;
            });

          if (donorCandidates.length > 0) {
            executeShiftMoveWithinWeek(donorCandidates[0], donorDay, zeroDay, "D");
            rescued = true;
            break;
          }
        }

        if (!rescued && countSnScOnFloor(zeroDay.dateString) === 0) {
          warnings.push({
            type: "floor_clinical_gap",
            date: zeroDay.dateString,
            day: zeroDay.dayName,
            floor: floorName,
            message: `${floorName} has neither Staff Nurse nor Senior Carer on ${zeroDay.dayName} (${zeroDay.dateString}) — all floor SN/SC staff are legally unavailable or on leave.`
          });
        }
      });
    });
  });

  // 6. Post-Scheduling Audit: Consecutive Work Streaks across Week Boundaries
  // User Decision #5: Warn if consecutive > 4 (or > 5 for maintenance staff) and suggest solutions
  Object.values(empState).forEach(st => {
    let streak = 0;
    let streakStart = null;
    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const maxConsecutive = isMaintenance ? 5 : 4;

    calendarDays.forEach((day, idx) => {
      const asgn = st.assignedShifts[day.dateString];
      if (asgn && (asgn.shift === "D" || asgn.shift === "N")) {
        if (streak === 0) streakStart = day.dateString;
        streak++;
      } else {
        if (streak > maxConsecutive) {
          warnings.push({
            type: "consecutive_streak",
            employee: st.name,
            streakLength: streak,
            startDate: streakStart,
            endDate: calendarDays[idx - 1].dateString,
            message: `${st.name} scheduled for ${streak} consecutive days (${streakStart} to ${calendarDays[idx - 1].dateString}).`,
            solution: "Give at least 1 rest day in between (e.g. shift Monday to Wednesday) to prevent staff fatigue."
          });
        }
        streak = 0;
      }
    });
  });

  // 7. Post-Scheduling Audit: Daily Staffing Quota vs Allotted vs Shortage
  // User Decision #3: Check shortages, rule conflicts, and generate actionable warnings with detailed reasons
  // Precompute flexible active required days per week for every role & shift (respects days_per_week without locking to Mon..Nth)
  const auditActiveDaysByWeek = weeks.map(wkDays => {
    const wkMap = { D: {}, N: {} };
    Object.keys(requirements).forEach(role => {
      const maxDays = getRoleDaysPerWeek(role);
      ["D", "N"].forEach(sType => {
        const base = getDailyBaseQuota(role, sType);
        if (base <= 0) {
          wkMap[sType][role] = new Set();
        } else {
          wkMap[sType][role] = getFlexibleActiveDaysForRole(wkDays, maxDays, (dateStr) => {
            return Object.values(empState).filter(st => {
              const a = st.assignedShifts[dateStr];
              return a && a.shift === sType && (sType === "N" || a.status !== "TR") && (a.coveringRole || st.designation) === role;
            }).length;
          });
        }
      });
    });
    return wkMap;
  });

  function getAuditRequiredQuota(role, shiftType, day, weekIdx) {
    const base = getDailyBaseQuota(role, shiftType);
    if (base <= 0) return 0;
    const activeSet = (weekIdx !== -1 && auditActiveDaysByWeek[weekIdx] && auditActiveDaysByWeek[weekIdx][shiftType])
      ? auditActiveDaysByWeek[weekIdx][shiftType][role]
      : null;
    if (!activeSet) return base;
    return activeSet.has(day.dateString) ? base : 0;
  }

  const dailyShortages = [];
  const ruleConflicts = [];
  calendarDays.forEach((day, dayIdx) => {
    const dStr = day.dateString;
    const weekIdx = weeks.findIndex(wk => wk.some(d => d.dateString === dStr));
    const wkDays = weekIdx !== -1 ? weeks[weekIdx] : [];

    const dayAllotted = Object.values(empState).filter(st => {
      const asgn = st.assignedShifts[dStr];
      return asgn && asgn.shift === "D" && asgn.status !== "TR";
    }).length;

    const nightAllotted = Object.values(empState).filter(st => {
      const asgn = st.assignedShifts[dStr];
      return asgn && asgn.shift === "N";
    }).length;

    // Calculate today's required totals dynamically based on flexible days_per_week for each role
    let todayRequiredDayTotal = 0;
    let todayRequiredNightTotal = 0;
    Object.keys(requirements).forEach(r => {
      todayRequiredDayTotal += getAuditRequiredQuota(r, "D", day, weekIdx);
      todayRequiredNightTotal += getAuditRequiredQuota(r, "N", day, weekIdx);
    });

    const dayShort = Math.max(0, todayRequiredDayTotal - dayAllotted);
    const nightShort = Math.max(0, todayRequiredNightTotal - nightAllotted);

    // 1. Role-by-Role Diagnosis for Day Shift
    const dayBreakdown = [];
    Object.keys(requirements).forEach(role => {
      const reqCount = getAuditRequiredQuota(role, "D", day, weekIdx);

      const allottedStaff = Object.values(empState).filter(st => {
        const asgn = st.assignedShifts[dStr];
        return asgn && asgn.shift === "D" && asgn.status !== "TR" && (asgn.coveringRole || st.designation) === role;
      });
      const allottedCount = allottedStaff.length;
      if (reqCount <= 0 && allottedCount <= 0) return;
      const shortCount = Math.max(0, reqCount - allottedCount);
      const overCount = Math.max(0, allottedCount - reqCount);

      if (shortCount > 0 || overCount > 0) {
        const reasons = [];
        // Inspect all active Day staff with this designation (omit night staff completely)
        const pool = Object.values(empState).filter(st => st.staffType === "D" && st.designation === role);
        pool.forEach(st => {
          const asgn = st.assignedShifts[dStr];
          if (asgn && asgn.shift === "D" && asgn.status !== "TR") return; // already allotted

          let reason = "";
          let conflictMeta = null;

          if (asgn && (isLeaveStatus(asgn.status) || asgn.leaveProtected)) {
            reason = asgn.leaveType ? `Approved ${asgn.leaveType}` : "Approved Leave";
            conflictMeta = {
              conflictingRules: "Approved Leave vs. Daily Staff Quota",
              winningRule: "Approved Leave",
              resolution: "Approved leave prioritized over staffing quota",
              impact: "Leave preserved; quota recorded as shortage",
              category: "Leave"
            };
          } else if (asgn && asgn.status === "TR") {
            reason = "Scheduled for Mandatory Training";
            conflictMeta = {
              conflictingRules: "Mandatory Training vs. Daily Staff Quota",
              winningRule: "Mandatory Training",
              resolution: "Mandatory training attended",
              impact: "Training preserved; quota recorded as shortage",
              category: "Training"
            };
          } else if (isUnavailable(st.id, dStr, day.dayName)) {
            reason = "Personal Unavailability: Staff requested this date off";
            conflictMeta = {
              conflictingRules: "Personal Unavailability vs. Daily Staff Quota",
              winningRule: "Staff Unavailability Request",
              resolution: "Personal preference honored",
              impact: "Staff off; quota recorded as shortage",
              category: "Preference"
            };
          } else {
            // Check consecutive days (max 4 days streak limit, 5 for maintenance staff)
            const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
            const maxConsecutive = isMaintenance ? 5 : 4;
            let consecutive = 1;
            for (let i = dayIdx - 1; i >= 0; i--) {
              const p = st.assignedShifts[calendarDays[i].dateString];
              if (p && (p.shift === "D" || p.shift === "N")) consecutive++;
              else break;
            }
            for (let i = dayIdx + 1; i < calendarDays.length; i++) {
              const n = st.assignedShifts[calendarDays[i].dateString];
              if (n && (n.shift === "D" || n.shift === "N")) consecutive++;
              else break;
            }

            if (consecutive > maxConsecutive) {
              reason = `Consecutive Days Limit: Staff already worked ${maxConsecutive} days in a row; resting to prevent a ${maxConsecutive + 1}-day streak`;
              conflictMeta = {
                conflictingRules: `Consecutive Days Limit (Max ${maxConsecutive} Days) vs. Daily Staff Quota`,
                winningRule: `${maxConsecutive}-Day Streak Safety Limit`,
                resolution: `Mandatory rest day enforced to prevent ${maxConsecutive + 1}-day fatigue streak`,
                impact: "Employee rested; quota recorded as shortage",
                category: "Fatigue & Safety"
              };
            } else if (day.dayName === "Monday" && dayIdx > 0) {
              const prevSunday = calendarDays[dayIdx - 1];
              const prevAsgn = prevSunday ? st.assignedShifts[prevSunday.dateString] : null;
              if (prevAsgn && prevAsgn.shift === "N") {
                reason = "Turnaround Rest: Worked Sunday night (finishes Mon 8am), resting before next shift";
                conflictMeta = {
                  conflictingRules: "Night-to-Day Turnaround Rest vs. Daily Staff Quota",
                  winningRule: "Turnaround Rest",
                  resolution: "Sleep turnaround enforced after night shift",
                  impact: "Employee rested; quota recorded as shortage",
                  category: "Fatigue & Safety"
                };
              }
            } else if (st.totalShiftsWorked >= st.totalMonthlyTargetShifts) {
              reason = "Contract Hours Reached: Contracted shift quota already fulfilled";
              conflictMeta = {
                conflictingRules: "Contract Cap (No Overstaffing) vs. Daily Staff Quota",
                winningRule: "Contract Cap",
                resolution: "Weekly contracted shift limit strictly maintained",
                impact: "Overtime prevented; quota recorded as shortage",
                category: "Contract Cap"
              };
            } else {
              reason = "Off duty (scheduled rest within contract hours)";
            }
          }

          if (reason) {
            reasons.push({ employeeName: st.name, employeeId: st.id, reason: reason, category: conflictMeta ? conflictMeta.category : "Scheduling" });
            if (conflictMeta) {
              ruleConflicts.push({
                date: dStr,
                dayName: day.dayName,
                shift: "D",
                shiftName: "Day",
                shiftType: "Day",
                role: role,
                employeeName: st.name,
                candidateName: st.name,
                employeeId: st.id,
                candidateId: st.id,
                rule: conflictMeta.conflictingRules,
                conflictingRules: conflictMeta.conflictingRules,
                winningRule: conflictMeta.winningRule,
                resolution: conflictMeta.resolution,
                impact: conflictMeta.impact,
                category: conflictMeta.category
              });
            }
          }
        });

        dayBreakdown.push({
          role: role,
          required: reqCount,
          allotted: allottedCount,
          shortage: shortCount,
          overstaffed: Math.max(0, allottedCount - reqCount),
          reasons: reasons
        });
      }
    });

    // 2. Role-by-Role Diagnosis for Night Shift
    const nightBreakdown = [];
    Object.keys(requirements).forEach(role => {
      const reqCount = getAuditRequiredQuota(role, "N", day, weekIdx);

      const allottedStaff = Object.values(empState).filter(st => {
        const asgn = st.assignedShifts[dStr];
        return asgn && asgn.shift === "N" && (asgn.coveringRole || st.designation) === role;
      });
      const allottedCount = allottedStaff.length;
      if (reqCount <= 0 && allottedCount <= 0) return;
      const shortCount = Math.max(0, reqCount - allottedCount);
      const overCount = Math.max(0, allottedCount - reqCount);

      if (shortCount > 0 || overCount > 0) {
        const reasons = [];
        // Inspect all active Night staff with this designation (omit day staff completely)
        const pool = Object.values(empState).filter(st => st.staffType === "N" && st.designation === role);
        pool.forEach(st => {
          const asgn = st.assignedShifts[dStr];
          if (asgn && asgn.shift === "N") return; // already allotted

          let reason = "";
          let conflictMeta = null;

          if (asgn && (isLeaveStatus(asgn.status) || asgn.leaveProtected)) {
            reason = asgn.leaveType ? `Approved ${asgn.leaveType}` : "Approved Leave";
            conflictMeta = {
              conflictingRules: "Approved Leave vs. Daily Night Quota",
              winningRule: "Approved Leave",
              resolution: "Approved leave prioritized over night staffing quota",
              impact: "Leave preserved; night quota recorded as shortage",
              category: "Leave"
            };
          } else if (asgn && asgn.isNightTrainingRest) {
            reason = "Mandatory Night Rest: Attending daytime training next morning";
            conflictMeta = {
              conflictingRules: "Mandatory Pre-Training Rest vs. Daily Night Quota",
              winningRule: "Mandatory Pre-Training Rest",
              resolution: "Night shift blocked prior to morning training session",
              impact: "Night staff rested; night quota recorded as shortage",
              category: "Training & Rest"
            };
          } else if (asgn && asgn.status === "TR") {
            reason = "Scheduled for Mandatory Training";
            conflictMeta = {
              conflictingRules: "Mandatory Training vs. Daily Night Quota",
              winningRule: "Mandatory Training",
              resolution: "Mandatory training attended",
              impact: "Training preserved; night quota recorded as shortage",
              category: "Training"
            };
          } else if (isUnavailable(st.id, dStr, day.dayName)) {
            reason = "Personal Unavailability: Staff requested this date off";
            conflictMeta = {
              conflictingRules: "Personal Unavailability vs. Daily Night Quota",
              winningRule: "Staff Unavailability Request",
              resolution: "Personal preference honored",
              impact: "Staff off; night quota recorded as shortage",
              category: "Preference"
            };
          } else {
            // Check consecutive days (max 4 days streak limit, 5 for maintenance staff)
            const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
            const maxConsecutive = isMaintenance ? 5 : 4;
            let consecutive = 1;
            for (let i = dayIdx - 1; i >= 0; i--) {
              const p = st.assignedShifts[calendarDays[i].dateString];
              if (p && (p.shift === "D" || p.shift === "N")) consecutive++;
              else break;
            }
            for (let i = dayIdx + 1; i < calendarDays.length; i++) {
              const n = st.assignedShifts[calendarDays[i].dateString];
              if (n && (n.shift === "D" || n.shift === "N")) consecutive++;
              else break;
            }

            if (consecutive > maxConsecutive) {
              reason = `Consecutive Days Limit: Staff already worked ${maxConsecutive} days in a row; resting to prevent a ${maxConsecutive + 1}-day streak`;
              conflictMeta = {
                conflictingRules: `Consecutive Days Limit (Max ${maxConsecutive} Days) vs. Daily Night Quota`,
                winningRule: `${maxConsecutive}-Day Streak Safety Limit`,
                resolution: `Mandatory rest enforced to prevent ${maxConsecutive + 1}-day fatigue streak`,
                impact: "Employee rested; night quota recorded as shortage",
                category: "Fatigue & Safety"
              };
            } else if (st.totalShiftsWorked >= st.totalMonthlyTargetShifts) {
              reason = "Contract Hours Reached: Contracted shift quota already fulfilled";
              conflictMeta = {
                conflictingRules: "Contract Cap (No Overstaffing) vs. Daily Night Quota",
                winningRule: "Contract Cap",
                resolution: "Weekly contracted shift limit strictly maintained",
                impact: "Overtime prevented; night quota recorded as shortage",
                category: "Contract Cap"
              };
            } else {
              reason = "Off duty (scheduled rest within contract hours)";
            }
          }

          if (reason) {
            reasons.push({ employeeName: st.name, employeeId: st.id, reason: reason, category: conflictMeta ? conflictMeta.category : "Scheduling" });
            if (conflictMeta) {
              ruleConflicts.push({
                date: dStr,
                dayName: day.dayName,
                shift: "N",
                shiftName: "Night",
                shiftType: "Night",
                role: role,
                employeeName: st.name,
                candidateName: st.name,
                employeeId: st.id,
                candidateId: st.id,
                rule: conflictMeta.conflictingRules,
                conflictingRules: conflictMeta.conflictingRules,
                winningRule: conflictMeta.winningRule,
                resolution: conflictMeta.resolution,
                impact: conflictMeta.impact,
                category: conflictMeta.category
              });
            }
          }
        });

        nightBreakdown.push({
          role: role,
          required: reqCount,
          allotted: allottedCount,
          shortage: shortCount,
          overstaffed: Math.max(0, allottedCount - reqCount),
          reasons: reasons
        });
      }
    });

    if (dayShort > 0) {
      clashes.push({
        date: dStr,
        day: day.dayName,
        shiftType: "Day",
        required: todayRequiredDayTotal,
        allotted: dayAllotted,
        shortage: dayShort,
        breakdown: dayBreakdown,
        message: `Understaffing on ${day.dayName} ${dStr} (Day Shift): ${dayAllotted} / ${todayRequiredDayTotal} staff allotted. Deficit: -${dayShort} staff.`,
        options: [
          "Call available bank or agency carers",
          "Offer voluntary overtime shift to off-duty staff",
          "Reschedule non-urgent staff leave or training"
        ]
      });
    }

    if (nightShort > 0) {
      clashes.push({
        date: dStr,
        day: day.dayName,
        shiftType: "Night",
        required: todayRequiredNightTotal,
        allotted: nightAllotted,
        shortage: nightShort,
        breakdown: nightBreakdown,
        message: `Understaffing on ${day.dayName} ${dStr} (Night Shift): ${nightAllotted} / ${todayRequiredNightTotal} staff allotted. Deficit: -${nightShort} staff.`,
        options: [
          "Call available bank or agency night nurses/carers",
          "Request night shift swap with day staff with night clearance"
        ]
      });
    }

    const daySurplus = Math.max(0, dayAllotted - todayRequiredDayTotal);
    const nightSurplus = Math.max(0, nightAllotted - todayRequiredNightTotal);

    dailyShortages.push({
      date: dStr,
      dayName: day.dayName,
      dayRequired: todayRequiredDayTotal,
      dayAllotted: dayAllotted,
      dayShortage: dayShort,
      dayOverstaffed: daySurplus,
      dayBreakdown: dayBreakdown,
      nightRequired: todayRequiredNightTotal,
      nightAllotted: nightAllotted,
      nightShortage: nightShort,
      nightOverstaffed: nightSurplus,
      nightBreakdown: nightBreakdown
    });
  });

  // 8. Compile Balances, Contract Shortages Diagnosis & Final Flat Rota Table
  const flatRota = [];
  const balances = [];
  const contractShortages = [];

  Object.values(empState).forEach(st => {
    let floorShifts = 0;
    let leaveShifts = 0;
    let trainingShifts = 0;

    calendarDays.forEach(day => {
      const asgn = st.assignedShifts[day.dateString] || { shift: "OFF", status: "OFF", coveringRole: st.designation };
      if (asgn.status === "D" || asgn.status === "N") floorShifts++;
      else if (isLeaveStatus(asgn.status) || asgn.isLeave) leaveShifts++;
      else if (asgn.status === "TR") trainingShifts++;

      const finalStatus = (asgn.shift === "OFF" && asgn.status === "OFF" && isSpecificDateRequestedOff(st.id, day.dateString))
        ? "R"
        : asgn.status;

      flatRota.push({
        date: day.dateString,
        dayName: day.dayName,
        employeeId: st.id, // backend-only, not exposed in UI tables
        employeeName: st.name,
        designation: st.designation,
        floor: st.floor || "",
        contractHours: st.contractHours,
        shiftHours: st.shiftHours,
        shift: asgn.shift,
        status: finalStatus,
        coveringRole: asgn.coveringRole || st.designation,
        trainingName: asgn.trainingName || "",
        isContractFulfillment: Boolean(asgn.isContractFulfillment)
      });
    });

    const nominalMonthlyContractHours = Math.round(st.contractHours * totalPeriodWeeksFloat * 10) / 10;
    const leaveDedHours = Math.round(leaveShifts * st.shiftHours * 10) / 10;
    const netContractHours = Math.max(0, Math.round((nominalMonthlyContractHours - leaveDedHours) * 10) / 10);
    const scheduledTargetHours = Math.round(st.totalMonthlyTargetShifts * st.shiftHours * 10) / 10;
    const floorHoursWorked = Math.round(floorShifts * st.shiftHours * 10) / 10;
    
    // Shortage against nominal net contract hours:
    const contractShortageHours = Math.max(0, Math.round((netContractHours - floorHoursWorked) * 10) / 10);

    balances.push({
      employeeId: st.id,
      employeeName: st.name,
      designation: st.designation,
      floor: st.floor || "",
      staffType: st.staffType,
      contractHours: st.contractHours,
      shiftHours: st.shiftHours,
      isRound: st.isRound,
      weeklyTargets: st.weeklyTargets,
      familyPeers: st.familyPeers || [],
      baseContractHours: nominalMonthlyContractHours,
      leaveDays: leaveShifts,
      leaveDedHours: leaveDedHours,
      netTargetHours: netContractHours,
      scheduledTargetHours: scheduledTargetHours,
      netTargetShifts: st.totalMonthlyTargetShifts,
      floorShiftsWorked: floorShifts,
      floorHoursWorked: floorHoursWorked,
      balanceRemaining: contractShortageHours,
      contractStatus: contractShortageHours === 0 ? "Fulfilled ✅" : `-${contractShortageHours} hrs (Shortage)`
    });

    // Detailed Diagnosis for any employee with an unfulfilled contract hour shortage
    if (contractShortageHours > 0) {
      let category = "Floor Quota Cap";
      let badgeColor = "#dc2626";
      let badgeBg = "#fee2e2";
      let reason = "";
      let tip = "";

      // Check if the shortage is due to daily shift indivisibility (contract cannot divide evenly into shift_hours without exceeding)
      const isDivisibilityIssue = !st.isRound && (floorHoursWorked === scheduledTargetHours) && (contractShortageHours > 0);

      if (isDivisibilityIssue) {
        category = "Divisibility & Rounding";
        badgeColor = "#d97706";
        badgeBg = "#fef3c7";
        const nextShiftHours = Math.round((floorHoursWorked + st.shiftHours) * 10) / 10;
        const potentialOvertime = Math.round((nextShiftHours - netContractHours) * 10) / 10;
        reason = `Shift-Hour Divisibility: ${st.contractHours}h/wk contract (${nominalMonthlyContractHours}h monthly) cannot be divided evenly into ${st.shiftHours}h daily shifts. The engine allocated ${floorShifts} shifts (${floorHoursWorked}h) to strictly enforce the zero-overtime rule (${floorShifts + 1} shifts = ${nextShiftHours}h would cause +${potentialOvertime}h overtime).`;
        const suggestedShiftHours = Math.round((st.contractHours / Math.round(st.contractHours / 8)) * 10) / 10;
        tip = `If this role works shorter shifts than floor carers (e.g., set Shift Duration to ${suggestedShiftHours}h in Staff Management), contract hours will tally to 100% with 0h deficit, or log ${contractShortageHours}h as an unworked contract balance.`;
      } else if (leaveShifts > 0 && floorShifts < st.totalMonthlyTargetShifts) {
        category = "Leave & Availability";
        badgeColor = "#2563eb";
        badgeBg = "#dbeafe";
        reason = `Approved Leave / Personal Preferences: Scheduled leave (${leaveShifts} days) or personal unavailability restricted the candidate working dates available to complete contracted shifts.`;
        tip = `Review leave coverage or offer voluntary shift swap on other available days.`;
      } else {
        category = "Zero Overstaffing Limit";
        badgeColor = "#dc2626";
        badgeBg = "#fee2e2";
        reason = `Floor Quota Met (Zero Overstaffing): Daily required staffing quota for ${st.designation} was already 100% met on all eligible days. Additional shifts were blocked to prevent unnecessary overstaffing.`;
        tip = `Review daily required quotas for ${st.designation} in Staff Requirements, or enable cross-role substitution in Role Hierarchy.`;
      }

      contractShortages.push({
        employeeId: st.id,
        employeeName: st.name,
        designation: st.designation,
        staffType: st.staffType,
        contractWeeklyHours: st.contractHours,
        shiftHours: st.shiftHours,
        nominalContractHours: nominalMonthlyContractHours,
        netContractHours: netContractHours,
        scheduledTargetHours: scheduledTargetHours,
        floorShiftsWorked: floorShifts,
        floorHoursWorked: floorHoursWorked,
        shortageHours: contractShortageHours,
        category: category,
        badgeColor: badgeColor,
        badgeBg: badgeBg,
        reason: reason,
        recommendation: tip
      });
    }
  });

  return {
    periodLabel: periodLabel || `Cycle (${startDateStr} to ${endDateStr})`,
    startDate: startDateStr,
    endDate: endDateStr,
    calendarDays: calendarDays,
    weeks: weeks.map((wDays, idx) => ({ num: idx + 1, days: wDays })),
    dailyRequiredTotals: { day: dailyRequiredDayTotal, night: dailyRequiredNightTotal },
    dailyShortages: dailyShortages,
    contractShortages: contractShortages,
    balances: balances,
    rota: flatRota,
    warnings: warnings,
    clashes: clashes,
    ruleConflicts: ruleConflicts,
    rolePriorityMap: rolePriorityMap,
    requirements: requirementsList,
    roleHierarchy: hierarchyList
  };
}

module.exports = { generateRotaForPeriod };
