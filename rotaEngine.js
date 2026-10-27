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

  // 1. Fetch live data from database (PostgreSQL or SQLite)
  const employees = await db.queryAll("SELECT * FROM employees WHERE active = 1");
  const requirementsList = await db.queryAll("SELECT * FROM requirements");
  const hierarchyList = await db.queryAll("SELECT * FROM role_hierarchy ORDER BY priority ASC");
  const leaveList = await db.queryAll("SELECT * FROM leave_records WHERE status = 'Approved'");
  const prefList = await db.queryAll("SELECT * FROM preferences");
  const trainingList = await db.queryAll("SELECT * FROM training_records");

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

  function getRoleRank(r) {
    if (!r) return 999;
    const lower = String(r).trim().toLowerCase();
    for (const [k, v] of Object.entries(roleRankMap)) {
      if (lower.includes(k)) return v;
    }
    return 100;
  }

  // Build requirements mapping
  const requirements = {};
  let dailyRequiredDayTotal = 0;
  let dailyRequiredNightTotal = 0;

  requirementsList.forEach(r => {
    requirements[r.role_name] = {
      day: r.day_required || 0,
      night: r.night_required || 0
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

  // Helper: Get required quota for role on a given day (respects days_per_week)
  function getRequiredQuota(role, shiftType, dayInfo) {
    const base = requirements[role] ? (shiftType === "D" ? requirements[role].day : requirements[role].night) : 0;
    if (base <= 0) return 0;
    const maxDays = roleDaysPerWeek[role] !== undefined ? roleDaysPerWeek[role] : 7;
    // Monday = 0, Tuesday = 1, ..., Sunday = 6
    const dIdxInWeek = (dayInfo.dayOfWeek + 6) % 7;
    if (dIdxInWeek >= maxDays) return 0;
    return base;
  }

  // Build 28-day calendar days (Monday to Sunday, 4 weeks)
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

  // Split into 4 discrete weeks (Monday to Sunday)
  const weeks = [];
  for (let i = 0; i < calendarDays.length; i += 7) {
    weeks.push(calendarDays.slice(i, i + 7));
  }

  // 2. Setup employee state, contract hours & patterns
  const empState = {};

  employees.forEach(emp => {
    const shiftHours = parseFloat(emp.shift_hours) || 11.0;
    const contractHours = parseFloat(emp.contract_hours) || 0;
    const isRound = (contractHours % shiftHours === 0);

    // Calculate weekly shift targets:
    // Round hours (44h, 33h, 22h, 11h) -> strict same shifts every week
    // Fractional / Non-round hours -> strictly capped so shifts * shiftHours <= monthlyContractHours (NO OVERTIME)
    const weeklyTargets = [];
    const monthlyContractHours = contractHours * weeks.length;
    const maxAllowedShifts = Math.floor(monthlyContractHours / shiftHours);

    if (isRound) {
      const shiftsPerWeek = Math.round(contractHours / shiftHours);
      for (let w = 0; w < weeks.length; w++) {
        weeklyTargets.push(shiftsPerWeek);
      }
    } else {
      // Distribute maxAllowedShifts across the weeks evenly without exceeding monthly contract
      let remaining = maxAllowedShifts;
      for (let w = 0; w < weeks.length; w++) {
        const weeksLeft = weeks.length - w;
        const shifts = Math.round(remaining / weeksLeft);
        weeklyTargets.push(shifts);
        remaining -= shifts;
      }
    }

    const totalMonthlyTargetShifts = weeklyTargets.reduce((a, b) => a + b, 0);

    // Check pattern preference
    const empPattern = prefList.find(p => p.employee_id === emp.id && p.type === "pattern");

    empState[emp.id] = {
      id: emp.id,
      name: emp.name,
      designation: emp.designation,
      floor: emp.floor || "",
      staffType: emp.staff_type || "D",
      contractHours: contractHours,
      shiftHours: shiftHours,
      isRound: isRound,
      weeklyTargets: weeklyTargets,
      totalMonthlyTargetShifts: totalMonthlyTargetShifts,
      pattern: empPattern || null,
      assignedShifts: {}, // dateString -> { shift: 'D'|'N'|'OFF'|'L'|'TR', status: 'D'|'N'|'OFF'|'L'|'TR', role: 'Carer' }
      totalShiftsWorked: 0,
      totalHoursWorked: 0,
      weekendCohort: "A",
      weekendsWorkedCount: 0
    };
  });

  // Assign alternating weekend cohorts (A vs B)
  // Cohort A: Works W1 & W3 weekends (weeks 0 & 2)
  // Cohort B: Works W2 & W4 weekends (weeks 1 & 3)
  const roleGroups = {};
  Object.values(empState).forEach(st => {
    const k = st.staffType + "_" + st.designation;
    if (!roleGroups[k]) roleGroups[k] = [];
    roleGroups[k].push(st);
  });

  Object.values(roleGroups).forEach(group => {
    group.forEach((st, idx) => {
      st.weekendCohort = idx % 2 === 0 ? "A" : "B";
      // For fractional 38.5h, 40h, and 15h workers, align targets properly with cohorts
      if (!st.isRound) {
        if (st.contractHours === 38.5) {
          st.weeklyTargets = st.weekendCohort === "A" ? [4, 3, 4, 3] : [3, 4, 3, 4];
        } else if (st.contractHours === 40) {
          // 40h/wk * 4 = 160h. Capped at 14 shifts (154h) to never exceed 160h contract
          st.weeklyTargets = st.weekendCohort === "A" ? [4, 3, 4, 3] : [3, 4, 3, 4];
        } else if (st.contractHours === 15) {
          // 15h/wk * 4 = 60h. Capped at 5 shifts (55h) to never exceed 60h contract
          st.weeklyTargets = st.weekendCohort === "A" ? [1, 1, 2, 1] : [1, 2, 1, 1];
        }
        st.totalMonthlyTargetShifts = st.weeklyTargets.reduce((a, b) => a + b, 0);
      }
    });
  });

  // Helper: Evaluate Pattern
  function isPatternWorkDay(state, targetDateStr) {
    if (!state.pattern || !state.pattern.pattern_work_days || !state.pattern.pattern_off_days) {
      return null; // No pattern
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
        state.assignedShifts[leaveDaysInWeek[0].dateString] = {
          shift: "OFF",
          status: "L",
          coveringRole: "",
          isLeave: true
        };
      } else {
        // Multi-day / long leave: record leave up to weekly contracted shifts
        const targetShifts = state.weeklyTargets[weekIdx] || Math.round(state.contractHours / state.shiftHours) || 4;

        if (leaveDaysInWeek.length <= targetShifts) {
          leaveDaysInWeek.forEach(day => {
            state.assignedShifts[day.dateString] = {
              shift: "OFF",
              status: "L",
              coveringRole: "",
              isLeave: true
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

          // Allotted up to targetShifts as "L", remainder as "OFF" (protected from work)
          sorted.forEach((day, idx) => {
            if (idx < targetShifts) {
              state.assignedShifts[day.dateString] = {
                shift: "OFF",
                status: "L",
                coveringRole: "",
                isLeave: true
              };
            } else {
              state.assignedShifts[day.dateString] = {
                shift: "OFF",
                status: "OFF",
                coveringRole: "",
                leaveProtected: true
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
      if (!state.assignedShifts[t.training_date] || state.assignedShifts[t.training_date].status !== "L") {
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
        if (!curAsgn || curAsgn.status !== "L") {
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
      if (p.employee_id !== empId) return false;
      if (p.preference !== "unavailable" && p.preference !== "off") return false;
      if (p.type === "date" && p.target_date === dStr) return true;
      if (p.type === "day" && p.target_day && p.target_day.toLowerCase().includes(dayName.toLowerCase())) return true;
      return false;
    });
  }

  // Helper: Check positive preference
  function hasPositivePref(empId, dStr, dayName) {
    return prefList.some(p => {
      if (p.employee_id !== empId) return false;
      if (p.preference !== "prefer") return false;
      if (p.type === "date" && p.target_date === dStr) return true;
      if (p.type === "day" && p.target_day && p.target_day.toLowerCase().includes(dayName.toLowerCase())) return true;
      return false;
    });
  }

  // 5. Week-by-Week Scheduling Loop
  weeks.forEach((weekDays, weekIdx) => {
    // Determine weekly targets for all staff with leave deductions
    employees.forEach(emp => {
      const state = empState[emp.id];
      state.shiftsThisWeek = 0;

      let leaveCount = 0;
      weekDays.forEach(d => {
        const asgn = state.assignedShifts[d.dateString];
        if (asgn && asgn.status === "L") leaveCount++;
      });

      const baseWeekly = state.weeklyTargets[weekIdx] || 0;
      let pastTarget = 0;
      for (let w = 0; w < weekIdx; w++) {
        pastTarget += state.weeklyTargets[w] || 0;
      }
      const shortfall = Math.max(0, pastTarget - state.totalShiftsWorked);
      const remainingMonthlyNeeded = Math.max(0, state.totalMonthlyTargetShifts - state.totalShiftsWorked);
      const allowedThisWeek = Math.min(5, Math.min(remainingMonthlyNeeded, baseWeekly + shortfall));
      state.workShiftsAllowedThisWeek = Math.max(0, allowedThisWeek - leaveCount);
      state.isWeekendWorkingWeek = (weekIdx % 2 === 0 && state.weekendCohort === "A") ||
                                   (weekIdx % 2 === 1 && state.weekendCohort === "B");
    });

    const dailyFilled = {};
    weekDays.forEach(d => {
      dailyFilled[d.dateString] = { D: {}, N: {} };
      Object.keys(requirements).forEach(r => {
        dailyFilled[d.dateString].D[r] = 0;
        dailyFilled[d.dateString].N[r] = 0;
      });
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
    }

    function canTakeShift(state, dayInfo, shiftType, coveredRole) {
      const dStr = dayInfo.dateString;
      if (state.staffType !== shiftType) return false;
      if (state.designation !== coveredRole) return false;
      if (state.assignedShifts[dStr]) return false; // Already assigned or on Leave

      // Strict contract hours enforcement: NO OVERSTAFFING
      if (state.shiftsThisWeek >= state.workShiftsAllowedThisWeek) return false;
      if (state.totalShiftsWorked >= state.totalMonthlyTargetShifts) return false;

      // Hard unavailability check
      if (isUnavailable(state.id, dStr, dayInfo.dayName)) return false;

      // Consecutive days limit (target 4, max 5 for maintenance staff)
      const isMaintenance = Boolean(state.designation && state.designation.toLowerCase().includes("maint"));
      const maxConsecutive = isMaintenance ? 5 : 4;
      const dayIdx = calendarDays.findIndex(d => d.dateString === dStr);
      let consecutive = 1;
      for (let i = dayIdx - 1; i >= 0; i--) {
        const prev = state.assignedShifts[calendarDays[i].dateString];
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = state.assignedShifts[calendarDays[i].dateString];
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }

      // Strictly enforce consecutive working days limit (5 for maintenance, 4 for others)
      if (consecutive > maxConsecutive) return false;

      // Night-to-Day Turnaround Rest:
      // If employee worked Sunday Night, they cannot work Monday Day (needs sleep turnaround)
      if (dayInfo.dayName === "Monday" && shiftType === "D" && dayIdx > 0) {
        const prevSunday = calendarDays[dayIdx - 1];
        const prevAsgn = prevSunday ? state.assignedShifts[prevSunday.dateString] : null;
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

    // Role order sorted by hierarchy rank
    const sortedRoles = Object.keys(requirements).sort((a, b) => getRoleRank(a) - getRoleRank(b));

    // PASS 1: Pattern Workers & Date Preferences First (User Decision #2)
    sortedRoles.forEach(reqRole => {
      ["D", "N"].forEach(shiftType => {
        weekDays.forEach(dayInfo => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, dayInfo);
          if (reqQuota <= 0) return;

          const dStr = dayInfo.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

          const candidates = Object.values(empState).filter(st => {
            if (!canTakeShift(st, dayInfo, shiftType, reqRole)) return false;
            // Check if pattern explicitly requests work
            const patternWork = isPatternWorkDay(st, dStr);
            if (patternWork === true) return true;
            // Or positive date preference
            if (hasPositivePref(st.id, dStr, dayInfo.dayName)) return true;
            return false;
          }).sort((a, b) => (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek));

          candidates.forEach(chosen => {
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota) {
              assignShift(chosen, dayInfo, shiftType, reqRole);
            }
          });
        });
      });
    });

    // PASS 2: Weekend Working (Saturday & Sunday paired consecutively)
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

            const candidates = Object.values(empState).filter(st => {
              if (!canTakeShift(st, wDay, shiftType, reqRole)) return false;
              // If employee has a pattern, pattern already took priority in Pass 1
              if (st.pattern) return isPatternWorkDay(st, dStr) !== false;
              // Non-pattern workers follow 2 weekends on / 2 off
              return st.isWeekendWorkingWeek;
            }).sort((a, b) => {
              // Priority to employees already working the other weekend day for pairing
              const otherDay = wDay === satDay ? sunDay : satDay;
              const aWorkedOther = otherDay && a.assignedShifts[otherDay.dateString] && a.assignedShifts[otherDay.dateString].shift !== "OFF";
              const bWorkedOther = otherDay && b.assignedShifts[otherDay.dateString] && b.assignedShifts[otherDay.dateString].shift !== "OFF";
              if (bWorkedOther && !aWorkedOther) return 1;
              if (aWorkedOther && !bWorkedOther) return -1;
              return (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek);
            });

            candidates.forEach(chosen => {
              if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota) {
                assignShift(chosen, wDay, shiftType, reqRole);
              }
            });
          });
        });
      });
    }

    // PASS 3: Adjacent Weekdays for Weekend Workers (Friday)
    const friDay = weekDays.find(d => d.dayName === "Friday");
    if (friDay) {
      sortedRoles.forEach(reqRole => {
        ["D", "N"].forEach(shiftType => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, friDay);
          if (reqQuota <= 0) return;

          const dStr = friDay.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

          const candidates = Object.values(empState).filter(st => {
            return canTakeShift(st, friDay, shiftType, reqRole);
          }).sort((a, b) => {
            // Primary: whoever needs the shift most to meet weekly/contract target!
            const needA = a.workShiftsAllowedThisWeek - a.shiftsThisWeek;
            const needB = b.workShiftsAllowedThisWeek - b.shiftsThisWeek;
            if (needB !== needA) return needB - needA;
            // Secondary: group with weekend
            const aHasWk = weekendDays.some(wd => a.assignedShifts[wd.dateString] && a.assignedShifts[wd.dateString].shift !== "OFF");
            const bHasWk = weekendDays.some(wd => b.assignedShifts[wd.dateString] && b.assignedShifts[wd.dateString].shift !== "OFF");
            if (bHasWk && !aHasWk) return 1;
            if (aHasWk && !bHasWk) return -1;
            return 0;
          });

          candidates.forEach(chosen => {
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota) {
              assignShift(chosen, friDay, shiftType, reqRole);
            }
          });
        });
      });
    }

    // PASS 4: Weekdays for Staff Needing Shifts
    const weekdaysOnly = weekDays.filter(d => !d.isWeekend);
    sortedRoles.forEach(reqRole => {
      ["D", "N"].forEach(shiftType => {
        weekdaysOnly.forEach(wDay => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, wDay);
          if (reqQuota <= 0) return;

          const dStr = wDay.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

          const candidates = Object.values(empState).filter(st => {
            return canTakeShift(st, wDay, shiftType, reqRole);
          }).sort((a, b) => (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek));

          candidates.forEach(chosen => {
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota) {
              assignShift(chosen, wDay, shiftType, reqRole);
            }
          });
        });
      });
    });

    // PASS 5: Role Hierarchy Substitutions (Strictly without exceeding contract hours)
    sortedRoles.forEach(reqRole => {
      ["D", "N"].forEach(shiftType => {
        weekDays.forEach(dayInfo => {
          const reqQuota = getRequiredQuota(reqRole, shiftType, dayInfo);
          if (reqQuota <= 0) return;

          const dStr = dayInfo.dateString;
          if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

          const substitutes = roleHierarchyMap[reqRole] || [reqRole];
          for (let sIdx = 1; sIdx < substitutes.length; sIdx++) {
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) break;
            const subRole = substitutes[sIdx];

            const candidates = Object.values(empState).filter(st => {
              return canTakeShift(st, dayInfo, shiftType, subRole);
            }).sort((a, b) => (b.workShiftsAllowedThisWeek - b.shiftsThisWeek) - (a.workShiftsAllowedThisWeek - a.shiftsThisWeek));

            candidates.forEach(chosen => {
              if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota) {
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

    // PASS 5.5: User Decision - Weekend rule can be skipped to fulfill contract hours
    if (weekendDays.length > 0) {
      sortedRoles.forEach(reqRole => {
        ["D", "N"].forEach(shiftType => {
          weekendDays.forEach(wDay => {
            const reqQuota = getRequiredQuota(reqRole, shiftType, wDay);
            if (reqQuota <= 0) return;

            const dStr = wDay.dateString;
            if ((dailyFilled[dStr][shiftType][reqRole] || 0) >= reqQuota) return;

            const candidates = Object.values(empState).filter(st => {
              if (st.shiftsThisWeek >= st.workShiftsAllowedThisWeek) return false;
              if (st.totalShiftsWorked >= st.totalMonthlyTargetShifts) return false;
              return canTakeShift(st, wDay, shiftType, reqRole);
            }).sort((a, b) => {
              const needA = a.workShiftsAllowedThisWeek - a.shiftsThisWeek;
              const needB = b.workShiftsAllowedThisWeek - b.shiftsThisWeek;
              if (needB !== needA) return needB - needA;
              return (b.totalMonthlyTargetShifts - b.totalShiftsWorked) - (a.totalMonthlyTargetShifts - a.totalShiftsWorked);
            });

            candidates.forEach(chosen => {
              if ((dailyFilled[dStr][shiftType][reqRole] || 0) < reqQuota) {
                assignShift(chosen, wDay, shiftType, reqRole);
              }
            });
          });
        });
      });
    }

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

  // PASS 7A: Monthly Contract Hours Equalization Sweep (Strict Quota / Zero Overstaffing)
  // User Instruction: 1st preference is meet contract hours without overstaffing.
  // Weekend rule can be skipped if needed to fulfill rota fairly.
  Object.values(empState).forEach(st => {
    // Count leave shifts already credited to this employee
    let empLeaveCount = 0;
    calendarDays.forEach(d => {
      const a = st.assignedShifts[d.dateString];
      if (a && a.status === "L") empLeaveCount++;
    });
    const netTargetShifts = Math.max(0, st.totalMonthlyTargetShifts - empLeaveCount);

    if (st.totalShiftsWorked >= netTargetShifts) return;

    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const maxConsecutive = isMaintenance ? 5 : 4;

    calendarDays.forEach((dayInfo, dayIdx) => {
      if (st.totalShiftsWorked >= netTargetShifts) return;
      const dStr = dayInfo.dateString;
      const shiftType = st.staffType;
      const reqRole = st.designation;
      const reqQuota = getRequiredQuota(reqRole, shiftType, dayInfo);

      // Check current filled on this day for this role
      const currentFilled = Object.values(empState).filter(s => {
        const asgn = s.assignedShifts[dStr];
        return asgn && asgn.shift === shiftType && asgn.status !== "TR" && (asgn.coveringRole === reqRole || s.designation === reqRole);
      }).length;

      // NO OVERSTAFFING: Only fill if current filled < required quota!
      if (currentFilled >= reqQuota) return;

      // Can this staff take this shift?
      // Do NOT overwrite days that are on leave, leave-protected, or night training rest!
      const existing = st.assignedShifts[dStr];
      if (existing) {
        if (existing.status === "L" || existing.leaveProtected || existing.isNightTrainingRest || existing.shift !== "OFF") {
          return;
        }
      }
      if (isUnavailable(st.id, dStr, dayInfo.dayName)) return;

      // Check consecutive days (max 5 for maintenance, 4 for others)
      let consecutive = 1;
      for (let i = dayIdx - 1; i >= 0; i--) {
        const prev = st.assignedShifts[calendarDays[i].dateString];
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = st.assignedShifts[calendarDays[i].dateString];
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }
      if (consecutive > maxConsecutive) return;

      // Turnaround Rest in Pass 7:
      if (dayInfo.dayName === "Monday" && shiftType === "D" && dayIdx > 0) {
        const prev = st.assignedShifts[calendarDays[dayIdx - 1].dateString];
        if (prev && prev.shift === "N") return;
      }

      // Night Staff Pre-Training Rest in Pass 7:
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

  // PASS 7B: Smart Overstaffing Fallback (User Rule)
  // If contract hours are not met because all role slots are filled, allot them to fulfill their contract
  // hours on days where the total staff count is lowest, while strictly respecting all safety and rest rules.
  Object.values(empState).forEach(st => {
    let empLeaveCount = 0;
    calendarDays.forEach(d => {
      const a = st.assignedShifts[d.dateString];
      if (a && a.status === "L") empLeaveCount++;
    });
    const netTargetShifts = Math.max(0, st.totalMonthlyTargetShifts - empLeaveCount);

    if (st.totalShiftsWorked >= netTargetShifts) return;

    const isMaintenance = Boolean(st.designation && st.designation.toLowerCase().includes("maint"));
    const maxConsecutive = isMaintenance ? 5 : 4;
    const shiftType = st.staffType;
    const reqRole = st.designation;

    // Collect candidate days that satisfy all safety and rest rules
    const candidateDays = [];
    calendarDays.forEach((dayInfo, dayIdx) => {
      const dStr = dayInfo.dateString;
      const existing = st.assignedShifts[dStr];
      if (existing) {
        if (existing.status === "L" || existing.leaveProtected || existing.isNightTrainingRest || existing.shift !== "OFF") {
          return;
        }
      }
      if (isUnavailable(st.id, dStr, dayInfo.dayName)) return;

      let consecutive = 1;
      for (let i = dayIdx - 1; i >= 0; i--) {
        const prev = st.assignedShifts[calendarDays[i].dateString];
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = st.assignedShifts[calendarDays[i].dateString];
        if (next && (next.shift === "D" || next.shift === "N")) consecutive++;
        else break;
      }
      if (consecutive > maxConsecutive) return;

      if (dayInfo.dayName === "Monday" && shiftType === "D" && dayIdx > 0) {
        const prev = st.assignedShifts[calendarDays[dayIdx - 1].dateString];
        if (prev && prev.shift === "N") return;
      }

      if (shiftType === "N" && dayIdx < calendarDays.length - 1) {
        const nextDay = calendarDays[dayIdx + 1];
        const nextAsgn = st.assignedShifts[nextDay.dateString];
        if (nextAsgn && nextAsgn.status === "TR") return;
      }

      // Count total staff on duty on this day for this shift
      const totalStaffOnDay = Object.values(empState).filter(s => {
        const asgn = s.assignedShifts[dStr];
        return asgn && asgn.shift === shiftType && asgn.status !== "TR";
      }).length;

      candidateDays.push({ dayInfo, dayIdx, totalStaffOnDay });
    });

    // Prioritize days with the lowest total staffing (smart overstaffing fallback)
    candidateDays.sort((a, b) => a.totalStaffOnDay - b.totalStaffOnDay);

    for (const cand of candidateDays) {
      if (st.totalShiftsWorked >= netTargetShifts) break;
      const dStr = cand.dayInfo.dateString;
      const dayIdx = cand.dayIdx;

      // Re-verify consecutive streak doesn't exceed limit
      let consecutive = 1;
      for (let i = dayIdx - 1; i >= 0; i--) {
        const prev = st.assignedShifts[calendarDays[i].dateString];
        if (prev && (prev.shift === "D" || prev.shift === "N")) consecutive++;
        else break;
      }
      for (let i = dayIdx + 1; i < calendarDays.length; i++) {
        const next = st.assignedShifts[calendarDays[i].dateString];
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

    // Calculate today's required totals dynamically based on days_per_week for each role
    let todayRequiredDayTotal = 0;
    let todayRequiredNightTotal = 0;
    Object.keys(requirements).forEach(r => {
      todayRequiredDayTotal += getRequiredQuota(r, "D", day);
      todayRequiredNightTotal += getRequiredQuota(r, "N", day);
    });

    const dayShort = Math.max(0, todayRequiredDayTotal - dayAllotted);
    const nightShort = Math.max(0, todayRequiredNightTotal - nightAllotted);

    // 1. Role-by-Role Diagnosis for Day Shift
    const dayBreakdown = [];
    Object.keys(requirements).forEach(role => {
      const reqCount = getRequiredQuota(role, "D", day);
      if (reqCount <= 0) return;

      const allottedStaff = Object.values(empState).filter(st => {
        const asgn = st.assignedShifts[dStr];
        return asgn && asgn.shift === "D" && asgn.status !== "TR" && (asgn.coveringRole === role || st.designation === role);
      });
      const allottedCount = allottedStaff.length;
      const shortCount = Math.max(0, reqCount - allottedCount);

      if (shortCount > 0) {
        const reasons = [];
        // Inspect all active Day staff with this designation (omit night staff completely)
        const pool = Object.values(empState).filter(st => st.staffType === "D" && st.designation === role);
        pool.forEach(st => {
          const asgn = st.assignedShifts[dStr];
          if (asgn && asgn.shift === "D" && asgn.status !== "TR") return; // already allotted

          let reason = "";
          let conflictMeta = null;

          if (asgn && (asgn.status === "L" || asgn.leaveProtected)) {
            reason = "Approved Annual Leave";
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
      const reqCount = getRequiredQuota(role, "N", day);
      if (reqCount <= 0) return;

      const allottedStaff = Object.values(empState).filter(st => {
        const asgn = st.assignedShifts[dStr];
        return asgn && asgn.shift === "N" && (asgn.coveringRole === role || st.designation === role);
      });
      const allottedCount = allottedStaff.length;
      const shortCount = Math.max(0, reqCount - allottedCount);

      if (shortCount > 0) {
        const reasons = [];
        // Inspect all active Night staff with this designation (omit day staff completely)
        const pool = Object.values(empState).filter(st => st.staffType === "N" && st.designation === role);
        pool.forEach(st => {
          const asgn = st.assignedShifts[dStr];
          if (asgn && asgn.shift === "N") return; // already allotted

          let reason = "";
          let conflictMeta = null;

          if (asgn && (asgn.status === "L" || asgn.leaveProtected)) {
            reason = "Approved Annual Leave";
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
      else if (asgn.status === "L") leaveShifts++;
      else if (asgn.status === "TR") trainingShifts++;

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
        status: asgn.status,
        coveringRole: asgn.coveringRole || st.designation,
        isContractFulfillment: Boolean(asgn.isContractFulfillment)
      });
    });

    const nominalMonthlyContractHours = Math.round(st.contractHours * weeks.length * 10) / 10;
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
    periodLabel: periodLabel || `4-Week Cycle (${startDateStr} to ${endDateStr})`,
    startDate: startDateStr,
    endDate: endDateStr,
    calendarDays: calendarDays,
    dailyRequiredTotals: { day: dailyRequiredDayTotal, night: dailyRequiredNightTotal },
    dailyShortages: dailyShortages,
    contractShortages: contractShortages,
    balances: balances,
    rota: flatRota,
    warnings: warnings,
    clashes: clashes,
    ruleConflicts: ruleConflicts,
    rolePriorityMap: rolePriorityMap
  };
}

module.exports = { generateRotaForPeriod };
