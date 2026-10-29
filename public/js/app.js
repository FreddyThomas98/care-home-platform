/* Care Home Rota Platform - Frontend Application Logic */

let currentUser = null;
let currentView = "rota";
let currentRotaData = null;
let selectedWeek = "all";
let rotaSubView = "weekly"; // "weekly" | "monthly" | "balances"
let matrixRoleFilter = "all";
let matrixTypeFilter = "all";
let matrixSearchQuery = "";
let balancesRoleFilter = "all";
let balancesStatusFilter = "all";
let balancesSearchQuery = "";
let currentConflictWeek = "all";
let currentConflictShift = "all";
let currentConflictSearch = "";
let currentConflictOnlyShortages = true;
let currentConflictTab = "contract"; // "contract" | "daily"
let currentContractShortageCategory = "all";
let currentContractShortageSearch = "";

// Token storage helpers
function getToken() {
  return localStorage.getItem("carehome_token");
}

function setToken(token) {
  localStorage.setItem("carehome_token", token);
}

function removeToken() {
  localStorage.removeItem("carehome_token");
}

// API request helper with Authorization header
async function apiFetch(endpoint, options = {}) {
  const token = getToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(endpoint, { ...options, headers });
  if (response.status === 401 || response.status === 403) {
    handleLogout();
    throw new Error("Session expired. Please log in.");
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

// Staff Sorting & Floor Grouping Helpers
function getStaffRolePriority(st, rolePriorityMap) {
  const role = st.designation || "";
  if (rolePriorityMap && rolePriorityMap[role] !== undefined) {
    return rolePriorityMap[role];
  }
  const lower = role.toLowerCase();
  if (lower.includes("manager")) return 1;
  if (lower.includes("clinical lead") || lower.includes("advanced")) return 2;
  if (lower.includes("team leader")) return 3;
  if (lower.includes("nurse")) return 4;
  if (lower.includes("senior carer")) return 5;
  if (lower.includes("carer")) return 6;
  if (lower.includes("physio")) return 7;
  if (lower.includes("wellbeing") || lower.includes("activities")) return 8;
  if (lower.includes("hostes")) return 9;
  if (lower.includes("maint")) return 10;
  return 100;
}

function sortStaffByPriority(staffList, rolePriorityMap) {
  return [...staffList].sort((a, b) => {
    const prioA = getStaffRolePriority(a, rolePriorityMap);
    const prioB = getStaffRolePriority(b, rolePriorityMap);
    if (prioA !== prioB) return prioA - prioB;
    return (a.employeeName || a.name || "").localeCompare(b.employeeName || b.name || "");
  });
}

function groupStaffByFloor(staffList, rolePriorityMap) {
  const noFloor = [];
  const topFloor = [];
  const groundFloor = [];
  const lowerGroundFloor = [];

  staffList.forEach(st => {
    const f = (st.floor || "").trim();
    if (f === "Top Floor") topFloor.push(st);
    else if (f === "Ground Floor") groundFloor.push(st);
    else if (f === "Lower Ground Floor") lowerGroundFloor.push(st);
    else noFloor.push(st);
  });

  return [
    { name: "", label: "", staff: sortStaffByPriority(noFloor, rolePriorityMap), showHeader: false },
    { name: "Top Floor", label: "🏢 Top Floor", staff: sortStaffByPriority(topFloor, rolePriorityMap), showHeader: true, bg: "#e0f2fe", color: "#0369a1" },
    { name: "Ground Floor", label: "🏢 Ground Floor", staff: sortStaffByPriority(groundFloor, rolePriorityMap), showHeader: true, bg: "#f0fdf4", color: "#15803d" },
    { name: "Lower Ground Floor", label: "🏢 Lower Ground Floor", staff: sortStaffByPriority(lowerGroundFloor, rolePriorityMap), showHeader: true, bg: "#fef3c7", color: "#92400e" }
  ];
}

/* ==========================================================
   AUTHENTICATION
   ========================================================= */

async function initApp() {
  const token = getToken();
  if (!token) {
    showLogin();
    return;
  }

  try {
    const res = await apiFetch("/api/auth/me");
    currentUser = res.user;
    showApp();
    switchView(currentView);
  } catch (err) {
    showLogin();
  }
}

function getUserInitials(name) {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function getStaffAvatarHtml(name) {
  if (!name) return "";
  const colors = ["#3b82f6", "#ef4444", "#8b5cf6", "#10b981", "#ec4899", "#f59e0b", "#06b6d4"];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const color = colors[Math.abs(hash) % colors.length];
  const initial = (name.trim()[0] || "U").toUpperCase();
  return `<span class="staff-avatar" style="background:${color};">${initial}</span>`;
}

function showLogin() {
  document.getElementById("loginSection").style.display = "flex";
  document.getElementById("appSection").style.display = "none";
}

function showApp() {
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("appSection").style.display = "flex";

  const initials = getUserInitials(currentUser.name);
  const avatarEl = document.getElementById("navUserAvatar");
  if (avatarEl) avatarEl.textContent = initials;

  const nameEl = document.getElementById("navUserName");
  if (nameEl) nameEl.textContent = currentUser.name;

  const roleEl = document.getElementById("navUserRole");
  if (roleEl) roleEl.textContent = currentUser.role === "admin" ? "Admin" : "Manager";

  // Show Admin Users Tab only for Admin
  const adminTab = document.getElementById("adminUsersTab");
  if (adminTab) {
    if (currentUser.role === "admin") {
      adminTab.style.display = "flex";
    } else {
      adminTab.style.display = "none";
    }
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;
  const alertEl = document.getElementById("loginAlert");
  const btn = document.getElementById("loginBtn");

  alertEl.style.display = "none";
  btn.disabled = true;
  btn.textContent = "Signing In...";

  try {
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    });

    setToken(res.token);
    currentUser = res.user;
    showApp();
    switchView("rota");
  } catch (err) {
    alertEl.textContent = err.message;
    alertEl.style.display = "block";
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign In to Platform";
  }
}

function handleLogout() {
  removeToken();
  currentUser = null;
  currentRotaData = null;
  const emailInput = document.getElementById("loginEmail");
  const passInput = document.getElementById("loginPassword");
  if (emailInput) emailInput.value = "";
  if (passInput) passInput.value = "";
  showLogin();
}

/* ==========================================================
   VIEW SWITCHING
   ========================================================= */

function switchView(viewName) {
  currentView = viewName;

  // Update tabs
  document.querySelectorAll(".nav-tab").forEach(tab => {
    tab.classList.remove("active");
  });
  const activeTab = Array.from(document.querySelectorAll(".nav-tab")).find(tab => {
    return tab.getAttribute("onclick")?.includes(`'${viewName}'`);
  });
  if (activeTab) activeTab.classList.add("active");

  const container = document.getElementById("viewContainer");
  container.innerHTML = `<div style="text-align:center; padding:40px; color:#64748b;">Loading view...</div>`;

  if (viewName === "rota") renderRotaView();
  else if (viewName === "shortage") renderShortageManagementView();
  else if (viewName === "employees") renderEmployeesView();
  else if (viewName === "requirements") renderRequirementsView();
  else if (viewName === "hierarchy") renderHierarchyView();
  else if (viewName === "leave") renderLeaveView();
  else if (viewName === "preferences") renderPreferencesView();
  else if (viewName === "training") renderTrainingView();
  else if (viewName === "users") renderUsersView();
}

/* Universal Helper: Reliable in-app confirmation modal (cannot be blocked by browser dialog settings) */
function showConfirmModal({ title = "Confirm Deletion", message = "Are you sure you want to delete this item? This action cannot be undone.", confirmBtnText = "Delete", onConfirm }) {
  const modalHtml = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" style="max-width:440px;" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3 style="color:#b91c1c;">⚠️ ${esc(title)}</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" style="padding:20px; font-size:14px; color:#334155; line-height:1.5;">
          ${esc(message)}
        </div>
        <div class="modal-footer" style="padding:12px 20px; display:flex; justify-content:flex-end; gap:10px;">
          <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
          <button type="button" id="confirmModalBtn" class="btn btn-danger">${esc(confirmBtnText)}</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = modalHtml;

  const btn = document.getElementById("confirmModalBtn");
  if (btn) {
    btn.onclick = async () => {
      closeModal();
      if (typeof onConfirm === "function") {
        await onConfirm();
      }
    };
  }
}

/* Helper to safely retrieve or construct weekly chunks from rota calendar days */
function getRotaWeeks(data) {
  if (data && Array.isArray(data.weeks) && data.weeks.length > 0) {
    return data.weeks;
  }
  const calendarDays = (data && data.calendarDays) || [];
  const weeks = [];
  for (let i = 0; i < calendarDays.length; i += 7) {
    weeks.push({
      num: (i / 7) + 1,
      days: calendarDays.slice(i, i + 7)
    });
  }
  return weeks;
}

/* Helper to evaluate role-wise shortages and overstaffing live for any day & shift */
function getShiftRoleStats(d, shiftType, rota, requirements, roleHierarchy, balances) {
  const reqList = (requirements && requirements.length > 0)
    ? requirements
    : [
        { role_name: 'Dy. Manager', day_required: 1, night_required: 0 },
        { role_name: 'Advanced Team Leader', day_required: 1, night_required: 0 },
        { role_name: 'Clinical Lead', day_required: 1, night_required: 0 },
        { role_name: 'Staff Nurse', day_required: 3, night_required: 3 },
        { role_name: 'Senior Carer', day_required: 3, night_required: 2 },
        { role_name: 'Team Leader', day_required: 1, night_required: 0 },
        { role_name: 'Carer', day_required: 10, night_required: 7 },
        { role_name: 'Wellbeing Staff', day_required: 2, night_required: 0 },
        { role_name: 'Hostes', day_required: 3, night_required: 0 },
        { role_name: 'Maintance Staff', day_required: 2, night_required: 0 },
        { role_name: 'Physiotherapist', day_required: 1, night_required: 0 }
      ];

  const roleDaysMap = {};
  (roleHierarchy || []).forEach(h => {
    roleDaysMap[h.required_role] = parseInt(h.days_per_week, 10) || 7;
  });

  const dIdx = (d.dayOfWeek + 6) % 7; // Mon=0, ..., Sun=6
  const shortRoles = [];
  const overRoles = [];

  const evaluatedRoleNames = [...new Set([
    ...reqList.map(r => r.role_name),
    ...(balances || []).map(b => b.designation)
  ])];

  let todayReqDayTotal = 0;
  let todayReqNightTotal = 0;

  evaluatedRoleNames.forEach(roleName => {
    const reqObj = reqList.find(r => r.role_name === roleName);
    const maxDays = roleDaysMap[roleName] !== undefined ? roleDaysMap[roleName] : 7;
    const isDayActive = dIdx < maxDays;

    const reqD = (reqObj && isDayActive) ? (reqObj.day_required || 0) : 0;
    const reqN = (reqObj && isDayActive) ? (reqObj.night_required || 0) : 0;

    todayReqDayTotal += reqD;
    todayReqNightTotal += reqN;

    const allottedD = (rota || []).filter(r =>
      r.date === d.dateString &&
      r.shift === "D" &&
      r.status !== "TR" &&
      (r.coveringRole === roleName || r.designation === roleName)
    ).length;

    const allottedN = (rota || []).filter(r =>
      r.date === d.dateString &&
      r.shift === "N" &&
      (r.coveringRole === roleName || r.designation === roleName)
    ).length;

    let rShort = 0;
    let rOver = 0;

    if (shiftType === "D") {
      rShort = Math.max(0, reqD - allottedD);
      rOver = Math.max(0, allottedD - reqD);
    } else if (shiftType === "N") {
      rShort = Math.max(0, reqN - allottedN);
      rOver = Math.max(0, allottedN - reqN);
    } else {
      const sD = Math.max(0, reqD - allottedD);
      const oD = Math.max(0, allottedD - reqD);
      const sN = Math.max(0, reqN - allottedN);
      const oN = Math.max(0, allottedN - reqN);
      rShort = sD + sN;
      rOver = oD + oN;
    }

    if (rShort > 0) {
      shortRoles.push({ role: roleName, shortage: rShort, reqD, reqN, allottedD, allottedN });
    }
    if (rOver > 0) {
      overRoles.push({ role: roleName, overstaffed: rOver, reqD, reqN, allottedD, allottedN });
    }
  });

  const totalShort = shortRoles.reduce((sum, r) => sum + r.shortage, 0);
  const totalOver = overRoles.reduce((sum, r) => sum + r.overstaffed, 0);
  const shortSummary = shortRoles.map(r => `-${r.shortage} ${r.role}`).join(', ');
  const overSummary = overRoles.map(r => `+${r.overstaffed} ${r.role}`).join(', ');

  return {
    shortRoles,
    overRoles,
    totalShort,
    totalOver,
    shortSummary,
    overSummary,
    todayReqDayTotal,
    todayReqNightTotal
  };
}

/* ==========================================================
   VIEW 1: ROTA GENERATOR & SCHEDULE
   ========================================================= */

async function renderRotaView() {
  const container = document.getElementById("viewContainer");

  try {
    if (!currentRotaData) {
      currentRotaData = await apiFetch("/api/rota/latest");
    }

    const { calendarDays, rota, balances, warnings, clashes, dailyRequiredTotals, dailyShortages, ruleConflicts } = currentRotaData;
    const conflictsList = ruleConflicts || [];

    const shortageMap = {};
    (dailyShortages || []).forEach(ds => {
      shortageMap[ds.date] = ds;
    });

    // Group calendar into weeks (7 days each)
    const weeks = getRotaWeeks(currentRotaData);
    currentRotaData.weeks = weeks;

    const activeWeeks = selectedWeek === "all" ? weeks : weeks.filter(w => String(w.num) === String(selectedWeek));

    // Calculate Dynamic KPI Metrics
    const dayStaffTotalCount = balances.filter(b => b.staffType === "D").length;
    const nightStaffTotalCount = balances.filter(b => b.staffType === "N").length;
    const totalShortagesCount = (currentRotaData.clashes || []).length;
    let totalOverstaffingCount = 0;
    (calendarDays || []).forEach(d => {
      const statD = getShiftRoleStats(d, "D", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
      const statN = getShiftRoleStats(d, "N", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
      totalOverstaffingCount += statD.totalOver + statN.totalOver;
    });
    const ruleConflictsCount = (conflictsList || []).length;

    let html = `
      <div class="card">
        <div class="card-header">
          <div class="card-title-group">
            <div class="card-icon-badge">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </div>
            <div>
              <div class="card-title">Rota Generator</div>
              <div class="card-subtitle">
                Create and manage staff rotas with automatic scheduling, compliance checks and shortage alerts.
              </div>
            </div>
          </div>

          <div class="card-actions-row">
            <select id="rotaPeriodSelect" class="select-filter-pill" style="font-weight:700;">
              <option value="P10_2026" data-start="2026-09-28" data-end="2026-10-25" selected>📅 Period 10 (2026): 28 Sep – 25 Oct</option>
              <option value="P11_2026" data-start="2026-10-26" data-end="2026-11-22">📅 Period 11 (2026): 26 Oct – 22 Nov</option>
              <option value="P12_2026" data-start="2026-11-23" data-end="2026-12-20">📅 Period 12 (2026): 23 Nov – 20 Dec</option>
            </select>

            <button class="btn btn-primary" onclick="triggerGenerateRota()">
              ⚡ Generate Rota
            </button>
            <button class="btn btn-secondary" onclick="exportRotaToExcel()">
              📥 Download Excel
            </button>
            <button class="btn btn-secondary" onclick="printRotaLandscape()">
              🖨️ Print
            </button>
          </div>
        </div>

        <!-- KPI Summary Metric Cards (Matching Reference Image 3) -->
        <div class="kpi-metrics-grid">
          <div class="kpi-card kpi-day-staff">
            <div class="kpi-card-icon">👥</div>
            <div>
              <div class="kpi-card-value">${dayStaffTotalCount}</div>
              <div class="kpi-card-label">Day Staff Active</div>
            </div>
          </div>

          <div class="kpi-card kpi-night-staff">
            <div class="kpi-card-icon">🌙</div>
            <div>
              <div class="kpi-card-value">${nightStaffTotalCount}</div>
              <div class="kpi-card-label">Night Staff Active</div>
            </div>
          </div>

          <div class="kpi-card kpi-shortages">
            <div class="kpi-card-icon">⚠️</div>
            <div>
              <div class="kpi-card-value">${totalShortagesCount}</div>
              <div class="kpi-card-label">Total Shortages</div>
            </div>
          </div>

          <div class="kpi-card kpi-overstaffing">
            <div class="kpi-card-icon">👤➕</div>
            <div>
              <div class="kpi-card-value">${totalOverstaffingCount}</div>
              <div class="kpi-card-label">Overstaffing</div>
            </div>
          </div>
        </div>

        <!-- Sub-Navigation & Overlapping Rules Button -->
        <div class="subnav-controls-row">
          <div class="subnav-pills-group">
            <button class="btn-subnav ${rotaSubView === 'weekly' ? 'active' : ''}" onclick="setRotaSubView('weekly')">
              📅 Weekly Shift Schedule
            </button>
            <button class="btn-subnav ${rotaSubView === 'monthly' ? 'active' : ''}" onclick="setRotaSubView('monthly')">
              👥 Staff-wise Monthly Matrix (28 Days)
            </button>
            <button class="btn-subnav ${rotaSubView === 'balances' ? 'active' : ''}" onclick="setRotaSubView('balances')">
              📊 Contract Hours & Balances
            </button>
          </div>

          <div>
            <button class="btn-shortage-alert" onclick="openRuleConflictsModal()">
              <span>⚠️</span>
              <span>Daily Shortages & Conflicting Rules</span>
              <span class="shortage-badge-counter">${(currentRotaData.clashes || []).length} Shortages</span>
              ${(currentRotaData.contractShortages && currentRotaData.contractShortages.length > 0) ? `
                <span class="shortage-badge-counter" style="background:#d97706;" title="Staff with unfulfilled contract hours">
                  ${currentRotaData.contractShortages.length} Contract Deficits
                </span>
              ` : ''}
              <span style="font-size:14px; font-weight:800;">›</span>
            </button>
          </div>
        </div>
    `;

    if (rotaSubView === "weekly") {
      html += `
        <!-- Weeks Selector & Shift Legend Row (Matching Reference Image 2) -->
        <div class="weeks-legend-row">
          <div class="weeks-selector-group">
            <button class="btn-week-pill" onclick="navigateWeek('prev')" title="Previous Week">‹</button>
            <button class="btn-week-pill ${selectedWeek === 'all' ? 'active' : ''}" onclick="setRotaWeek('all')">
              All Weeks (4)
            </button>
            ${weeks.map(w => `
              <button class="btn-week-pill ${String(selectedWeek) === String(w.num) ? 'active' : ''}" onclick="setRotaWeek('${w.num}')">
                Week ${w.num} (${formatShortDate(w.days[0].dateString)} - ${formatShortDate(w.days[6].dateString)})
              </button>
            `).join('')}
            <button class="btn-week-pill" onclick="navigateWeek('next')" title="Next Week">›</button>
          </div>

          <div class="shift-legend-group">
            <div class="legend-item"><span class="status-pill status-D">D</span> Day Shift</div>
            <div class="legend-item"><span class="status-pill status-N">N</span> Night Shift</div>
            <div class="legend-item"><span class="status-pill status-OFF">OFF</span> Off Duty</div>
            <div class="legend-item"><span class="status-pill status-L">L</span> Approved Leave</div>
            <div class="legend-item"><span class="status-pill status-TR">TR</span> Training</div>
          </div>
        </div>
      </div>
      `;

      // Render Weekly Tables
      activeWeeks.forEach(week => {
        const days = week.days;

        // Filter Day Staff (exclude all-off in this week)
        const dayStaff = balances.filter(st => {
          if (st.staffType !== "D") return false;
          return days.some(d => {
            const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
            return rec && rec.status !== "OFF";
          });
        });

        // Filter Night Staff
        const nightStaff = balances.filter(st => {
          if (st.staffType !== "N") return false;
          return days.some(d => {
            const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
            return rec && rec.status !== "OFF";
          });
        });

        // Compute Day & Night Allotted per day
        const dayAllotted = days.map(d => {
          return rota.filter(r => r.date === d.dateString && r.shift === "D" && r.status !== "TR").length;
        });

        const nightAllotted = days.map(d => {
          return rota.filter(r => r.date === d.dateString && r.shift === "N").length;
        });

        html += `
          <div class="card">
            <!-- Table Search & Filter Bar (Matching Reference Image 2) -->
            <div class="table-filter-bar">
              <div class="table-title-wrap">
                <div style="font-weight:800; font-size:16px; color:#0f172a; display:flex; align-items:center; gap:8px;">
                  <span>📅</span> Week ${week.num} Schedule ⌵
                </div>
                <div style="font-size:12px; color:#64748b; font-weight:600;">
                  ${days[0].dateString} – ${days[6].dateString}
                </div>
              </div>

              <div class="table-filter-inputs">
                <input type="text" class="search-input-pill" placeholder="Search staff..." oninput="filterWeeklyStaffTable(this.value)">
                <select class="select-filter-pill" onchange="filterWeeklyRoleTable(this.value)">
                  <option value="all">All Roles ⌵</option>
                  <option value="Staff Nurse">Staff Nurse</option>
                  <option value="Senior Carer">Senior Carer</option>
                  <option value="Carer">Carer</option>
                  <option value="Team Leader">Team Leader</option>
                </select>
                <select class="select-filter-pill">
                  <option value="all">All Locations ⌵</option>
                  <option value="Ground Floor">Ground Floor</option>
                  <option value="Top Floor">Top Floor</option>
                  <option value="Lower Ground Floor">Lower Ground Floor</option>
                </select>
                <select class="select-filter-pill">
                  <option value="default">⚙️ View Options ⌵</option>
                </select>
              </div>
            </div>

            <!-- ☀️ DAY SHIFT TABLE -->
            <div class="shift-section-title shift-day-title">
              <span>☀️ Day Shift Schedule</span>
              <span>Day Staff Active: ${dayStaff.length}</span>
            </div>

            <div class="table-responsive" style="overflow-x:hidden; width:100%;">
              <table class="rota-staff-table" style="width:100%; table-layout:fixed;">
                <thead>
                  <tr>
                    <th style="width:17%; min-width:140px; padding:8px 6px;">Staff Name</th>
                    <th style="width:13%; min-width:100px; padding:8px 4px;">Role</th>
                    <th style="width:12%; min-width:90px; padding:8px 4px;">Contract Target</th>
                    ${days.map(d => {
                      const stat = getShiftRoleStats(d, "D", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
                      const isShort = stat.totalShort > 0;
                      const isOver = stat.totalOver > 0;
                      return `
                        <th style="text-align:center; width:8.1%; min-width:60px; padding:6px 2px; ${isShort ? 'background:#fff1f2;' : isOver ? 'background:#eff6ff;' : ''}">
                          <strong style="color:#0f172a; font-size:11.5px;">${d.dayName.substring(0,3)}</strong><br>
                          <small style="color:#64748b; font-weight:600; font-size:10px;">${formatShortDate(d.dateString)}</small>
                          ${isShort && isOver ? `
                            <div style="margin-top:2px; display:flex; justify-content:center; gap:2px;">
                              <span class="badge-short-tag">Short</span>
                              <span class="badge-over-tag">Over</span>
                            </div>
                          ` : isShort ? `
                            <div style="margin-top:2px;">
                              <span class="badge-short-tag">Short</span>
                            </div>
                          ` : isOver ? `
                            <div style="margin-top:2px;">
                              <span class="badge-over-tag">Over</span>
                            </div>
                          ` : ''}
                        </th>
                      `;
                    }).join('')}
                    <th style="text-align:center; width:3%; min-width:28px; padding:0;"></th>
                  </tr>
                </thead>
                <tbody>
                  ${groupStaffByFloor(dayStaff, currentRotaData.rolePriorityMap).map(grp => {
                    if (grp.staff.length === 0) return '';
                    return `
                      ${grp.showHeader ? `
                        <tr class="floor-group-header">
                          <td colspan="${4 + days.length}">
                            🏢 ${grp.label.replace('🏢 ', '')} &nbsp;•&nbsp; <span style="font-size:11px; font-weight:600; opacity:0.9;">${grp.staff.length} Active Staff</span>
                          </td>
                        </tr>
                      ` : ''}
                      ${grp.staff.map(st => {
                        const targetThisWeek = st.weeklyTargets[week.num - 1] || 0;
                        return `
                          <tr class="staff-row-item" data-name="${esc(st.employeeName).toLowerCase()}" data-role="${esc(st.designation)}">
                            <td>
                              <div style="display:flex; align-items:center; gap:10px;">
                                ${getStaffAvatarHtml(st.employeeName)}
                                <div style="font-weight:700; color:#0f172a;">${esc(st.employeeName)}</div>
                              </div>
                            </td>
                            <td style="font-weight:600; color:#334155;">${esc(st.designation)}</td>
                            <td style="font-weight:600;">${st.contractHours}h <span style="color:#059669; font-size:12px; font-weight:700;">(Tgt: ${targetThisWeek} shf)</span></td>
                            ${days.map(d => {
                              const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                              const status = rec ? rec.status : "OFF";
                              return `<td style="text-align:center;"><span class="status-pill status-${status}">${status}</span></td>`;
                            }).join('')}
                            <td style="text-align:center; color:#94a3b8; font-weight:bold; cursor:pointer;" title="Staff options">⋮</td>
                          </tr>
                        `;
                      }).join('')}
                    `;
                  }).join('')}

                  <!-- REQUIRED STAFF ROW -->
                  <tr style="background:#f8fafc; font-weight:700; border-top:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#475569;">Required Staff:</td>
                    ${days.map(d => {
                      const stat = getShiftRoleStats(d, "D", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
                      return `<td style="text-align:center; color:#475569; font-weight:700;">${stat.todayReqDayTotal}</td>`;
                    }).join('')}
                    <td></td>
                  </tr>

                  <!-- ALLOTTED STAFF ROW -->
                  <tr style="background:#f1f5f9; font-weight:800;">
                    <td colspan="3" style="text-align:right; color:#0f172a;">Allotted Staff:</td>
                    ${days.map((d, idx) => `<td style="text-align:center; color:#0f172a; font-size:14px; font-weight:800;">${dayAllotted[idx]}</td>`).join('')}
                    <td></td>
                  </tr>

                  <!-- SHORTAGE & OVERSTAFFING ROW -->
                  <tr style="background:#ffffff; font-weight:800; border-bottom:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#0f172a; vertical-align:middle;">Coverage Status:</td>
                    ${days.map(d => {
                      const stat = getShiftRoleStats(d, "D", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
                      const short = stat.totalShort;
                      const over = stat.totalOver;
                      const roleShorts = stat.shortRoles;
                      const roleOvers = stat.overRoles;

                      if (short > 0 && over > 0) {
                        return `
                          <td style="text-align:center; background:#fef2f2; border:1px solid #fca5a5; padding:6px 3px; vertical-align:top;">
                            <div style="display:flex; justify-content:center; align-items:center; gap:3px; margin-bottom:4px; flex-wrap:wrap;">
                              <span class="badge-short-tag" title="Shortage on this day">Short: -${short}</span>
                              <button type="button" onclick="openShortageDetail('${d.dateString}', 'D')" title="Click to view reasons for this shortage" style="background:#b91c1c; color:#ffffff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; line-height:16px; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.2);">ℹ</button>
                              <span class="badge-over-tag" title="Overstaffed on this day">Over: +${over}</span>
                            </div>
                            <div style="font-size:10px; line-height:1.25; font-weight:700; text-align:center;">
                              ${roleShorts.map(b => `<div style="color:#b91c1c; white-space:nowrap; margin-top:1px;">🔴 -${b.shortage} ${esc(b.role)}</div>`).join('')}
                              ${roleOvers.map(b => `<div style="color:#2563eb; white-space:nowrap; margin-top:1px;">🔵 +${b.overstaffed} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      } else if (short > 0) {
                        return `
                          <td style="text-align:center; color:#dc2626; background:#fee2e2; border:1px solid #fca5a5; padding:6px 3px; vertical-align:top;">
                            <div style="display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:4px;">
                              <span class="badge-short-tag" title="Shortage on this day">Short: -${short}</span>
                              <button type="button" onclick="openShortageDetail('${d.dateString}', 'D')" title="Click to view reasons for this shortage" style="background:#b91c1c; color:#ffffff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; line-height:16px; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.2);">ℹ</button>
                            </div>
                            <div style="font-size:10px; line-height:1.25; font-weight:700; text-align:center;">
                              ${roleShorts.map(b => `<div style="color:#b91c1c; white-space:nowrap; margin-top:1px;">🔴 -${b.shortage} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      } else if (over > 0) {
                        return `
                          <td style="text-align:center; color:#3730a3; background:#e0e7ff; border:1px solid #c7d2fe; padding:6px 3px; vertical-align:top;">
                            <div style="display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:4px;">
                              <span class="badge-over-tag" title="Overstaffed on this day">Over: +${over}</span>
                            </div>
                            <div style="font-size:10px; line-height:1.25; font-weight:700; text-align:center;">
                              ${roleOvers.map(b => `<div style="color:#2563eb; white-space:nowrap; margin-top:1px;">🔵 +${b.overstaffed} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      }
                      return `<td style="text-align:center; color:#15803d; background:#dcfce7; font-weight:800; border:1px solid #86efac; font-size:12px; vertical-align:middle;"><span class="badge-met">0 ✅</span></td>`;
                    }).join('')}
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 🌙 NIGHT SHIFT TABLE -->
            <div class="shift-section-title shift-night-title">
              <span>🌙 Night Shift Schedule</span>
              <span>Night Staff Active: ${nightStaff.length}</span>
            </div>

            <div class="table-responsive" style="overflow-x:hidden; width:100%;">
              <table class="night-table rota-staff-table" style="width:100%; table-layout:fixed;">
                <thead>
                  <tr>
                    <th style="width:17%; min-width:140px; padding:8px 6px;">Staff Name</th>
                    <th style="width:13%; min-width:100px; padding:8px 4px;">Role</th>
                    <th style="width:12%; min-width:90px; padding:8px 4px;">Contract Target</th>
                    ${days.map(d => {
                      const stat = getShiftRoleStats(d, "N", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
                      const isShort = stat.totalShort > 0;
                      const isOver = stat.totalOver > 0;
                      return `
                        <th style="text-align:center; width:8.1%; min-width:60px; padding:6px 2px; ${isShort ? 'background:#fff1f2;' : isOver ? 'background:#eff6ff;' : ''}">
                          <strong style="color:#0f172a; font-size:11.5px;">${d.dayName.substring(0,3)}</strong><br>
                          <small style="color:#64748b; font-weight:600; font-size:10px;">${formatShortDate(d.dateString)}</small>
                          ${isShort && isOver ? `
                            <div style="margin-top:2px; display:flex; justify-content:center; gap:2px;">
                              <span class="badge-short-tag">Short</span>
                              <span class="badge-over-tag">Over</span>
                            </div>
                          ` : isShort ? `
                            <div style="margin-top:2px;">
                              <span class="badge-short-tag">Short</span>
                            </div>
                          ` : isOver ? `
                            <div style="margin-top:2px;">
                              <span class="badge-over-tag">Over</span>
                            </div>
                          ` : ''}
                        </th>
                      `;
                    }).join('')}
                    <th style="text-align:center; width:3%; min-width:28px; padding:0;"></th>
                  </tr>
                </thead>
                <tbody>
                  ${sortStaffByPriority(nightStaff, currentRotaData.rolePriorityMap).map(st => {
                    const targetThisWeek = st.weeklyTargets[week.num - 1] || 0;
                    return `
                      <tr class="staff-row-item" data-name="${esc(st.employeeName).toLowerCase()}" data-role="${esc(st.designation)}">
                        <td>
                          <div style="display:flex; align-items:center; gap:10px;">
                            ${getStaffAvatarHtml(st.employeeName)}
                            <div style="font-weight:700; color:#0f172a;">${esc(st.employeeName)}</div>
                          </div>
                        </td>
                        <td style="font-weight:600; color:#334155;">${esc(st.designation)}</td>
                        <td style="font-weight:600;">${st.contractHours}h <span style="color:#059669; font-size:12px; font-weight:700;">(Tgt: ${targetThisWeek} shf)</span></td>
                        ${days.map(d => {
                          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                          const status = rec ? rec.status : "OFF";
                          return `<td style="text-align:center;"><span class="status-pill status-${status}">${status}</span></td>`;
                        }).join('')}
                        <td style="text-align:center; color:#94a3b8; font-weight:bold; cursor:pointer;" title="Staff options">⋮</td>
                      </tr>
                    `;
                  }).join('')}

                  <!-- REQUIRED STAFF ROW -->
                  <tr style="background:#f8fafc; font-weight:700; border-top:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#475569;">Required Staff:</td>
                    ${days.map(d => {
                      const stat = getShiftRoleStats(d, "N", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
                      return `<td style="text-align:center; color:#475569; font-weight:700;">${stat.todayReqNightTotal}</td>`;
                    }).join('')}
                  </tr>

                  <!-- ALLOTTED STAFF ROW -->
                  <tr style="background:#f1f5f9; font-weight:800;">
                    <td colspan="3" style="text-align:right; color:#0f172a;">Allotted Staff:</td>
                    ${days.map((d, idx) => `<td style="text-align:center; color:#0f172a; font-size:14px; font-weight:800;">${nightAllotted[idx]}</td>`).join('')}
                  </tr>

                  <!-- SHORTAGE & OVERSTAFFING ROW -->
                  <tr style="background:#ffffff; font-weight:800; border-bottom:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#0f172a; vertical-align:middle;">Coverage Status:</td>
                    ${days.map(d => {
                      const stat = getShiftRoleStats(d, "N", rota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
                      const short = stat.totalShort;
                      const over = stat.totalOver;
                      const roleShorts = stat.shortRoles;
                      const roleOvers = stat.overRoles;

                      if (short > 0 && over > 0) {
                        return `
                          <td style="text-align:center; background:#fef2f2; border:1px solid #fca5a5; padding:6px 3px; vertical-align:top;">
                            <div style="display:flex; justify-content:center; align-items:center; gap:3px; margin-bottom:4px; flex-wrap:wrap;">
                              <span class="badge-shortage" title="Shortage on this day">Short: -${short}</span>
                              <button type="button" onclick="openShortageDetail('${d.dateString}', 'N')" title="Click to view reasons for this shortage" style="background:#b91c1c; color:#ffffff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; line-height:16px; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.2);">ℹ</button>
                              <span class="badge-overstaffed" title="Overstaffed on this day">Over: +${over}</span>
                            </div>
                            <div style="font-size:10px; line-height:1.25; font-weight:700; text-align:center;">
                              ${roleShorts.map(b => `<div style="color:#b91c1c; white-space:nowrap; margin-top:1px;">🔴 -${b.shortage} ${esc(b.role)}</div>`).join('')}
                              ${roleOvers.map(b => `<div style="color:#2563eb; white-space:nowrap; margin-top:1px;">🔵 +${b.overstaffed} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      } else if (short > 0) {
                        return `
                          <td style="text-align:center; color:#dc2626; background:#fee2e2; border:1px solid #fca5a5; padding:6px 3px; vertical-align:top;">
                            <div style="display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:4px;">
                              <span class="badge-shortage" title="Shortage on this day">Short: -${short}</span>
                              <button type="button" onclick="openShortageDetail('${d.dateString}', 'N')" title="Click to view reasons for this shortage" style="background:#b91c1c; color:#ffffff; border:none; border-radius:50%; width:16px; height:16px; font-size:10px; line-height:16px; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.2);">ℹ</button>
                            </div>
                            <div style="font-size:10px; line-height:1.25; font-weight:700; text-align:center;">
                              ${roleShorts.map(b => `<div style="color:#b91c1c; white-space:nowrap; margin-top:1px;">🔴 -${b.shortage} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      } else if (over > 0) {
                        return `
                          <td style="text-align:center; color:#3730a3; background:#e0e7ff; border:1px solid #c7d2fe; padding:6px 3px; vertical-align:top;">
                            <div style="display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:4px;">
                              <span class="badge-overstaffed" title="Overstaffed on this day">Over: +${over}</span>
                            </div>
                            <div style="font-size:10px; line-height:1.25; font-weight:700; text-align:center;">
                              ${roleOvers.map(b => `<div style="color:#2563eb; white-space:nowrap; margin-top:1px;">🔵 +${b.overstaffed} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      }
                      return `<td style="text-align:center; color:#15803d; background:#dcfce7; font-weight:800; border:1px solid #86efac; font-size:12px; vertical-align:middle;"><span class="badge-met">0 ✅</span></td>`;
                    }).join('')}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        `;
      });
    } else if (rotaSubView === "monthly") {
      html += `</div>`; // Close top card
      html += renderMonthlyMatrixHtml(currentRotaData);
    } else if (rotaSubView === "balances") {
      html += `</div>`; // Close top card
      html += renderContractBalancesHtml(currentRotaData);
    }

    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error loading rota: ${err.message}</div>`;
  }
}

function setRotaWeek(week) {
  selectedWeek = week;
  renderRotaView();
}

function navigateWeek(dir) {
  if (selectedWeek === "all") {
    selectedWeek = dir === "next" ? "1" : "4";
  } else {
    let num = parseInt(selectedWeek, 10);
    if (dir === "next") {
      num = num >= 4 ? 1 : num + 1;
    } else {
      num = num <= 1 ? 4 : num - 1;
    }
    selectedWeek = String(num);
  }
  renderRotaView();
}

function filterWeeklyStaffTable(query) {
  const q = (query || "").trim().toLowerCase();
  document.querySelectorAll(".staff-row-item").forEach(tr => {
    const name = tr.getAttribute("data-name") || "";
    if (!q || name.includes(q)) {
      tr.style.display = "";
    } else {
      tr.style.display = "none";
    }
  });
}

function filterWeeklyRoleTable(role) {
  document.querySelectorAll(".staff-row-item").forEach(tr => {
    const r = tr.getAttribute("data-role") || "";
    if (role === "all" || r === role) {
      tr.style.display = "";
    } else {
      tr.style.display = "none";
    }
  });
}

function setRotaSubView(subView) {
  rotaSubView = subView;
  renderRotaView();
}

function updateMatrixRoleFilter(val) {
  matrixRoleFilter = val;
  renderRotaView();
}

function updateMatrixTypeFilter(val) {
  matrixTypeFilter = val;
  renderRotaView();
}

function updateMatrixSearch(val) {
  matrixSearchQuery = val;
  renderRotaView();
}

function updateBalancesRoleFilter(val) {
  balancesRoleFilter = val;
  renderRotaView();
}

function updateBalancesStatusFilter(val) {
  balancesStatusFilter = val;
  renderRotaView();
}

function updateBalancesSearch(val) {
  balancesSearchQuery = val;
  renderRotaView();
}

function renderMonthlyMatrixHtml(data) {
  const { calendarDays, rota, balances, dailyRequiredTotals } = data;
  const allRoles = [...new Set(balances.map(b => b.designation))].sort();

  let filteredStaff = balances.filter(st => {
    if (matrixRoleFilter !== "all" && st.designation !== matrixRoleFilter) return false;
    if (matrixTypeFilter !== "all" && st.staffType !== matrixTypeFilter) return false;
    if (matrixSearchQuery.trim()) {
      const q = matrixSearchQuery.trim().toLowerCase();
      const matchName = (st.employeeName || "").toLowerCase().includes(q);
      const matchRole = (st.designation || "").toLowerCase().includes(q);
      if (!matchName && !matchRole) return false;
    }
    return true;
  });

  const rotaIndex = {};
  (rota || []).forEach(r => {
    rotaIndex[r.employeeId + "_" + r.date] = r;
  });

  return `
    <div class="card" style="margin-top:16px;">
      <!-- Filter Bar -->
      <div style="padding:14px 20px; background:#ffffff; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
          <div>
            <label style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; display:block; margin-bottom:3px;">Filter Role</label>
            <select class="form-control" style="width:auto; padding:6px 10px; font-size:13px;" onchange="updateMatrixRoleFilter(this.value)">
              <option value="all" ${matrixRoleFilter === 'all' ? 'selected' : ''}>All Roles (${balances.length} Staff)</option>
              ${allRoles.map(r => `<option value="${esc(r)}" ${matrixRoleFilter === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
          </div>

          <div>
            <label style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; display:block; margin-bottom:3px;">Shift Contract</label>
            <select class="form-control" style="width:auto; padding:6px 10px; font-size:13px;" onchange="updateMatrixTypeFilter(this.value)">
              <option value="all" ${matrixTypeFilter === 'all' ? 'selected' : ''}>All Shift Types</option>
              <option value="D" ${matrixTypeFilter === 'D' ? 'selected' : ''}>☀️ Day Shift Staff</option>
              <option value="N" ${matrixTypeFilter === 'N' ? 'selected' : ''}>🌙 Night Shift Staff</option>
            </select>
          </div>

          <div>
            <label style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; display:block; margin-bottom:3px;">Search Staff</label>
            <input type="text" class="form-control" placeholder="Search name or role..." style="width:200px; padding:6px 10px; font-size:13px;" value="${esc(matrixSearchQuery)}" oninput="updateMatrixSearch(this.value)">
          </div>
        </div>

        <div style="font-size:12px; color:#64748b; display:flex; gap:14px; align-items:center; font-weight:600; flex-wrap:wrap;">
          <span>Showing <strong>${filteredStaff.length}</strong> of ${balances.length} staff</span>
          <span style="border-left:1px solid #cbd5e1; height:16px;"></span>
          <span><span class="status-pill status-D">D</span> Day</span>
          <span><span class="status-pill status-N">N</span> Night</span>
          <span><span class="status-pill status-OFF">OFF</span> Off</span>
          <span><span class="status-pill status-L">L</span> Leave</span>
          <span><span class="status-pill status-TR">TR</span> Training</span>
        </div>
      </div>

      <!-- 28-Day Full Matrix Table -->
      <div class="table-responsive" style="max-height:720px; overflow-x:auto; overflow-y:auto;">
        <table class="matrix-table" style="background:#ffffff; border-collapse:collapse;">
          <thead style="position:sticky; top:0; z-index:10; background:#f8fafc; box-shadow:0 2px 4px rgba(0,0,0,0.06);">
            <!-- Week Header Row -->
            <tr>
              <th rowspan="2" class="matrix-sticky-name-th" style="min-width:170px; padding:8px 10px; border-right:2px solid #cbd5e1;">Staff Member</th>
              <th rowspan="2" class="matrix-sticky-role-th" style="min-width:140px; padding:8px 10px; border-right:2px solid #cbd5e1;">Role</th>
              <th rowspan="2" style="min-width:65px; text-align:center; padding:8px 4px; border-right:1px solid #cbd5e1; background:#f8fafc;">Type</th>
              <th rowspan="2" style="min-width:75px; text-align:center; padding:8px 4px; border-right:1px solid #cbd5e1; background:#f8fafc;" title="Net Contract Target Hours">Tgt Hrs</th>
              <th rowspan="2" style="min-width:75px; text-align:center; padding:8px 4px; border-right:2px solid #0b3542; background:#f8fafc;" title="Floor Hours Worked">Wrk Hrs</th>

              <th colspan="7" class="week-sep-left" style="text-align:center; background:#e0f2fe; color:#0369a1; font-weight:800; font-size:12px; border-right:1px solid #bae6fd; padding:6px;">
                WEEK 1 (${formatShortDate(calendarDays[0].dateString)} – ${formatShortDate(calendarDays[6].dateString)})
              </th>
              <th colspan="7" class="week-sep-left" style="text-align:center; background:#f0fdf4; color:#15803d; font-weight:800; font-size:12px; border-right:1px solid #bbf7d0; padding:6px;">
                WEEK 2 (${formatShortDate(calendarDays[7].dateString)} – ${formatShortDate(calendarDays[13].dateString)})
              </th>
              <th colspan="7" class="week-sep-left" style="text-align:center; background:#fefce8; color:#a16207; font-weight:800; font-size:12px; border-right:1px solid #fef08a; padding:6px;">
                WEEK 3 (${formatShortDate(calendarDays[14].dateString)} – ${formatShortDate(calendarDays[20].dateString)})
              </th>
              <th colspan="7" class="week-sep-left" style="text-align:center; background:#faf5ff; color:#7e22ce; font-weight:800; font-size:12px; padding:6px;">
                WEEK 4 (${formatShortDate(calendarDays[21].dateString)} – ${formatShortDate(calendarDays[27].dateString)})
              </th>
            </tr>

            <!-- Day Header Row -->
            <tr style="background:#ffffff;">
              ${calendarDays.map((d, idx) => {
                const isWkStart = idx % 7 === 0;
                return `
                  <th class="${isWkStart ? 'week-sep-left' : ''} ${d.isWeekend ? 'weekend-hdr' : ''}" style="text-align:center; min-width:36px; padding:4px 2px; font-size:11px; ${d.isWeekend ? 'background:#f1f5f9;' : 'background:#ffffff;'}">
                    <span style="font-weight:800; color:#0f172a;">${d.dayName.substring(0, 2)}</span><br>
                    <span style="font-size:10px; color:#64748b;">${d.dateString.split('-')[2]}</span>
                  </th>
                `;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${filteredStaff.length === 0 ? `
              <tr>
                <td colspan="33" style="text-align:center; padding:30px; color:#64748b; font-style:italic;">
                  No staff members match the selected filters.
                </td>
              </tr>
            ` : groupStaffByFloor(filteredStaff, currentRotaData.rolePriorityMap).map(grp => {
              if (grp.staff.length === 0) return '';
              return `
                ${grp.showHeader ? `
                  <tr style="background:${grp.bg}; color:${grp.color}; font-weight:800; font-size:12px; border-top:2px solid #cbd5e1; border-bottom:1px solid ${grp.color}30;">
                    <td colspan="${5 + calendarDays.length}" style="padding:7px 12px; letter-spacing:0.3px;">
                      ${grp.label} &nbsp;•&nbsp; <span style="font-size:11px; font-weight:600; opacity:0.85;">${grp.staff.length} Staff Members</span>
                    </td>
                  </tr>
                ` : ''}
                ${grp.staff.map(st => {
                  const isDayType = st.staffType === "D";
                  return `
                    <tr style="border-bottom:1px solid #f1f5f9;">
                      <td class="matrix-sticky-name" style="padding:6px 10px; border-right:2px solid #e2e8f0;">
                        <strong>${esc(st.employeeName)}</strong>
                      </td>
                      <td class="matrix-sticky-role" style="padding:6px 10px; border-right:2px solid #e2e8f0; font-size:12px; color:#334155;">
                        ${esc(st.designation)}
                      </td>
                      <td style="text-align:center; padding:4px; border-right:1px solid #e2e8f0; font-size:11px;">
                        ${isDayType ? '<span style="color:#d97706; font-weight:700;">☀️ Day</span>' : '<span style="color:#4f46e5; font-weight:700;">🌙 Ngt</span>'}
                      </td>
                      <td style="text-align:center; padding:4px; border-right:1px solid #e2e8f0; font-size:11px; font-weight:600; color:#475569;" title="Contract Net Target: ${st.netTargetHours}h">
                        ${st.netTargetHours}h
                      </td>
                      <td style="text-align:center; padding:4px; border-right:2px solid #0b3542; font-size:11px; font-weight:700; ${st.floorHoursWorked < st.netTargetHours ? 'color:#d97706;' : 'color:#15803d;'}" title="${st.floorHoursWorked < st.netTargetHours ? `Shortage: -${Math.round((st.netTargetHours - st.floorHoursWorked)*10)/10}h (click Daily Shortages to view diagnosis)` : 'Contract Hours Fulfilled'}">
                        ${st.floorHoursWorked}h
                      </td>

                      <!-- 28 Days Cells -->
                      ${calendarDays.map((d, idx) => {
                        const rec = rotaIndex[st.employeeId + "_" + d.dateString];
                        const status = rec ? rec.status : "OFF";
                        const isWkStart = idx % 7 === 0;

                        let pill = `<span style="color:#cbd5e1; font-size:11px;">—</span>`;
                        if (status === "D") pill = `<span class="status-pill status-D" style="padding:2px 4px; font-size:10px;">D</span>`;
                        else if (status === "N") pill = `<span class="status-pill status-N" style="padding:2px 4px; font-size:10px;">N</span>`;
                        else if (status === "L") pill = `<span class="status-pill status-L" style="padding:2px 4px; font-size:10px;" title="Leave">L</span>`;
                        else if (status === "TR") pill = `<span class="status-pill status-TR" style="padding:2px 4px; font-size:10px;" title="Training">TR</span>`;

                        return `
                          <td class="${isWkStart ? 'week-sep-left' : ''} ${d.isWeekend ? 'weekend-hdr' : ''}" style="text-align:center; padding:3px 1px; border-right:1px solid #f1f5f9;">
                            ${pill}
                          </td>
                        `;
                      }).join('')}
                    </tr>
                  `;
                }).join('')}
              `;
            }).join('')}
          </tbody>
          <tfoot style="position:sticky; bottom:0; z-index:8; background:#f8fafc; box-shadow:0 -2px 4px rgba(0,0,0,0.05); font-weight:800;">
            <!-- Day Staff On Duty Counter -->
            <tr style="background:#f8fafc; border-top:2px solid #cbd5e1;">
              <td colspan="2" class="matrix-sticky-name" style="text-align:right; padding:6px 10px; font-size:12px; color:#0b3542; border-right:2px solid #cbd5e1; background:#f8fafc;">
                ☀️ Day Staff On Duty (Req: ${dailyRequiredTotals.day})
              </td>
              <td colspan="3" style="text-align:center; font-size:11px; color:#64748b; border-right:2px solid #0b3542;">
                Quota: ${dailyRequiredTotals.day}/day
              </td>
              ${calendarDays.map((d, idx) => {
                const count = rota.filter(r => r.date === d.dateString && r.shift === "D" && r.status !== "TR").length;
                const isShort = count < dailyRequiredTotals.day;
                const isOver = count > dailyRequiredTotals.day;
                const isWkStart = idx % 7 === 0;
                let bgStyle = "color:#0f172a;";
                if (isShort) bgStyle = "background:#fee2e2; color:#b91c1c;";
                else if (isOver) bgStyle = "background:#e0e7ff; color:#3730a3; font-weight:800;";
                return `
                  <td class="${isWkStart ? 'week-sep-left' : ''}" style="text-align:center; font-size:11px; padding:4px 1px; ${bgStyle}" title="${count} day staff ${isOver ? `(+${count - dailyRequiredTotals.day} Overstaffed)` : isShort ? `(-${dailyRequiredTotals.day - count} Shortage)` : '(Target Met)'}">
                    ${count}
                  </td>
                `;
              }).join('')}
            </tr>

            <!-- Night Staff On Duty Counter -->
            <tr style="background:#f1f5f9; border-top:1px solid #e2e8f0;">
              <td colspan="2" class="matrix-sticky-name" style="text-align:right; padding:6px 10px; font-size:12px; color:#0b3542; border-right:2px solid #cbd5e1; background:#f1f5f9;">
                🌙 Night Staff On Duty (Req: ${dailyRequiredTotals.night})
              </td>
              <td colspan="3" style="text-align:center; font-size:11px; color:#64748b; border-right:2px solid #0b3542;">
                Quota: ${dailyRequiredTotals.night}/night
              </td>
              ${calendarDays.map((d, idx) => {
                const count = rota.filter(r => r.date === d.dateString && r.shift === "N").length;
                const isShort = count < dailyRequiredTotals.night;
                const isOver = count > dailyRequiredTotals.night;
                const isWkStart = idx % 7 === 0;
                let bgStyle = "color:#0f172a;";
                if (isShort) bgStyle = "background:#fee2e2; color:#b91c1c;";
                else if (isOver) bgStyle = "background:#e0e7ff; color:#3730a3; font-weight:800;";
                return `
                  <td class="${isWkStart ? 'week-sep-left' : ''}" style="text-align:center; font-size:11px; padding:4px 1px; ${bgStyle}" title="${count} night staff ${isOver ? `(+${count - dailyRequiredTotals.night} Overstaffed)` : isShort ? `(-${dailyRequiredTotals.night - count} Shortage)` : '(Target Met)'}">
                    ${count}
                  </td>
                `;
              }).join('')}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  `;
}

function renderContractBalancesHtml(data) {
  const { balances } = data;
  const allRoles = [...new Set(balances.map(b => b.designation))].sort();

  const totalStaff = balances.length;
  const totalContractBaseHours = balances.reduce((sum, b) => sum + (b.contractHours * 4), 0);
  const totalLeaveDedHours = balances.reduce((sum, b) => sum + (b.leaveDedHours || 0), 0);
  const totalNetTargetHours = balances.reduce((sum, b) => sum + (b.netTargetHours || 0), 0);
  const totalFloorHoursWorked = balances.reduce((sum, b) => sum + (b.floorHoursWorked || 0), 0);
  const totalBalanceRemaining = balances.reduce((sum, b) => sum + (b.balanceRemaining || 0), 0);
  const fulfilledStaffCount = balances.filter(b => b.balanceRemaining === 0).length;
  const carriedOverStaffCount = balances.filter(b => b.balanceRemaining > 0).length;
  const fulfillmentRatePct = Math.round((fulfilledStaffCount / totalStaff) * 100);

  let filteredBalances = balances.filter(b => {
    if (balancesRoleFilter !== "all" && b.designation !== balancesRoleFilter) return false;
    if (balancesStatusFilter === "fulfilled" && b.balanceRemaining > 0) return false;
    if (balancesStatusFilter === "carried_over" && b.balanceRemaining === 0) return false;
    if (balancesSearchQuery.trim()) {
      const q = balancesSearchQuery.trim().toLowerCase();
      const matchName = (b.employeeName || "").toLowerCase().includes(q);
      const matchRole = (b.designation || "").toLowerCase().includes(q);
      if (!matchName && !matchRole) return false;
    }
    return true;
  });

  return `
    <!-- Top KPI Stat Cards (Clean 4-Card Executive Layout) -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-card-title">🏢 Net Target Hours</div>
        <div class="stat-card-val">${totalNetTargetHours.toLocaleString()} <span style="font-size:14px; font-weight:600; color:#64748b;">hrs</span></div>
        <div class="stat-card-desc">Base: ${totalContractBaseHours.toLocaleString()}h – Leave: ${totalLeaveDedHours}h</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-title">🏥 Floor Hours Worked</div>
        <div class="stat-card-val" style="color:#059669;">${totalFloorHoursWorked.toLocaleString()} <span style="font-size:14px; font-weight:600; color:#64748b;">hrs</span></div>
        <div class="stat-card-desc">${Math.round((totalFloorHoursWorked / totalNetTargetHours) * 100)}% of net target fulfilled</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-title">🏖️ Leave Deductions</div>
        <div class="stat-card-val" style="color:#0284c7;">${totalLeaveDedHours.toLocaleString()} <span style="font-size:14px; font-weight:600; color:#64748b;">hrs</span></div>
        <div class="stat-card-desc">${balances.reduce((s,b)=>s+(b.leaveDays||0),0)} approved leave days deducted</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-title">🎯 Fulfillment Rate</div>
        <div class="stat-card-val" style="color:#0f766e;">${fulfillmentRatePct}%</div>
        <div class="stat-card-desc">${fulfilledStaffCount} of ${totalStaff} staff 100% fulfilled</div>
      </div>
    </div>

    <!-- Contract Balances Table Card -->
    <div class="card">
      <div class="card-header" style="background:#ffffff; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
          <div>
            <label style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; display:block; margin-bottom:3px;">Filter Role</label>
            <select class="form-control" style="width:auto; padding:6px 10px; font-size:13px;" onchange="updateBalancesRoleFilter(this.value)">
              <option value="all" ${balancesRoleFilter === 'all' ? 'selected' : ''}>All Roles (${balances.length})</option>
              ${allRoles.map(r => `<option value="${esc(r)}" ${balancesRoleFilter === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>
          </div>

          <div>
            <label style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; display:block; margin-bottom:3px;">Fulfillment Status</label>
            <select class="form-control" style="width:auto; padding:6px 10px; font-size:13px;" onchange="updateBalancesStatusFilter(this.value)">
              <option value="all" ${balancesStatusFilter === 'all' ? 'selected' : ''}>All Statuses (${balances.length})</option>
              <option value="fulfilled" ${balancesStatusFilter === 'fulfilled' ? 'selected' : ''}>✅ 100% Fulfilled (${fulfilledStaffCount})</option>
              <option value="carried_over" ${balancesStatusFilter === 'carried_over' ? 'selected' : ''}>⚠️ Carried Forward (${carriedOverStaffCount})</option>
            </select>
          </div>

          <div>
            <label style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; display:block; margin-bottom:3px;">Search Staff</label>
            <input type="text" class="form-control" placeholder="Search name or role..." style="width:200px; padding:6px 10px; font-size:13px;" value="${esc(balancesSearchQuery)}" oninput="updateBalancesSearch(this.value)">
          </div>
        </div>

        <div style="font-size:13px; color:#64748b; font-weight:600;">
          Showing <strong>${filteredBalances.length}</strong> of ${totalStaff} staff members
        </div>
      </div>

      <div class="table-responsive" style="overflow-x:hidden;">
        <table style="width:100%; table-layout:auto; font-size:12.5px;">
          <thead>
            <tr>
              <th style="padding:10px 8px;">Staff Member</th>
              <th style="padding:10px 8px;">Role</th>
              <th style="text-align:center; padding:10px 6px;">Type</th>
              <th style="text-align:center; padding:10px 6px;">Weekly Contract</th>
              <th style="text-align:center; padding:10px 6px;">4-Wk Base</th>
              <th style="text-align:center; padding:10px 6px;">Leave Deduct</th>
              <th style="text-align:center; padding:10px 6px;">Net Target</th>
              <th style="text-align:center; padding:10px 6px;">Floor Worked</th>
              <th style="text-align:center; padding:10px 6px;">Balance</th>
              <th style="min-width:85px; padding:10px 8px;">Target Progress</th>
              <th style="text-align:center; padding:10px 8px;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${filteredBalances.length === 0 ? `
              <tr>
                <td colspan="11" style="text-align:center; padding:30px; color:#64748b; font-style:italic;">
                  No staff members match the selected balance filter.
                </td>
              </tr>
            ` : filteredBalances.map(b => {
              const base4Wk = b.contractHours * 4;
              const pct = b.netTargetHours > 0 ? Math.min(100, Math.round((b.floorHoursWorked / b.netTargetHours) * 100)) : 100;
              const isFulfilled = b.balanceRemaining === 0;

              return `
                <tr>
                  <td><strong>${esc(b.employeeName)}</strong></td>
                  <td>${esc(b.designation)}</td>
                  <td style="text-align:center;">
                    ${b.staffType === 'D' ? '<span style="color:#d97706; font-weight:700;">☀️ Day</span>' : '<span style="color:#4f46e5; font-weight:700;">🌙 Ngt</span>'}
                  </td>
                  <td style="text-align:center; font-weight:600;">${b.contractHours}h/wk</td>
                  <td style="text-align:center;">${base4Wk}h</td>
                  <td style="text-align:center;">
                    ${b.leaveDays > 0 ? `<span style="color:#2563eb; font-weight:700;">-${b.leaveDedHours}h (${b.leaveDays}d)</span>` : '<span style="color:#94a3b8;">0h</span>'}
                  </td>
                  <td style="text-align:center; font-weight:700; color:#0b3542;">
                    ${b.netTargetHours}h <span style="font-size:11px; color:#64748b;">(${b.netTargetShifts !== undefined ? b.netTargetShifts : Math.round(b.netTargetHours / (b.shiftHours || 11))} shf)</span>
                  </td>
                  <td style="text-align:center; font-weight:700; ${isFulfilled ? 'color:#15803d;' : 'color:#b91c1c;'}">
                    ${b.floorHoursWorked}h <span style="font-size:11px; color:#64748b;">(${b.floorShiftsWorked} shf)</span>
                  </td>
                  <td style="text-align:center; font-weight:800; ${isFulfilled ? 'color:#15803d;' : 'color:#b91c1c;'}">
                    ${isFulfilled ? '0h' : `-${b.balanceRemaining}h`}
                  </td>
                  <td>
                    <div style="display:flex; align-items:center; gap:8px;">
                      <div style="flex:1; background:#e2e8f0; border-radius:4px; height:8px; overflow:hidden;">
                        <div style="width:${pct}%; background:${pct === 100 ? '#10b981' : '#f59e0b'}; height:100%; border-radius:4px;"></div>
                      </div>
                      <span style="font-size:11px; font-weight:700; min-width:32px;">${pct}%</span>
                    </div>
                  </td>
                  <td style="text-align:center;">
                    ${isFulfilled ? `
                      <span class="badge" style="background:#dcfce7; color:#15803d; font-weight:700; padding:3px 8px; border-radius:4px; font-size:11px;">
                        Fulfilled ✅
                      </span>
                    ` : `
                      <span class="badge" style="background:#fef3c7; color:#b45309; font-weight:700; padding:4px 10px; border-radius:6px; font-size:11px; cursor:pointer; display:inline-flex; align-items:center; gap:4px; border:1px solid #fde68a;" onclick="openRuleConflictsModal(null, 'contract')" title="Click to view full shortage diagnosis">
                        -${b.balanceRemaining}h Deficit 🔍
                      </span>
                    `}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function triggerGenerateRota() {
  const select = document.getElementById("rotaPeriodSelect");
  const opt = select.options[select.selectedIndex];
  const sDate = opt.dataset.start;
  const eDate = opt.dataset.end;
  const pLabel = opt.text;

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = "⚡ Generating...";

  try {
    const res = await apiFetch("/api/rota/generate", {
      method: "POST",
      body: JSON.stringify({ startDate: sDate, endDate: eDate, periodLabel: pLabel })
    });
    currentRotaData = res;
    renderRotaView();
  } catch (err) {
    alert("Generation error: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Generate Rota";
  }
}

function openShortageDetail(dateString, shiftType) {
  if (!currentRotaData) return;
  const days = currentRotaData.calendarDays || [];
  const d = days.find(day => day.dateString === dateString) || { dateString, dayName: "", dayOfWeek: 1 };
  const stat = getShiftRoleStats(d, shiftType, currentRotaData.rota, currentRotaData.requirements, currentRotaData.roleHierarchy, currentRotaData.balances);
  const ds = (currentRotaData.dailyShortages || []).find(x => x.date === dateString) || {};

  const isDay = shiftType === "D";
  const shiftName = isDay ? "Day Shift" : "Night Shift";
  const reqTotal = isDay ? (ds.dayRequired || stat.todayReqDayTotal) : (ds.nightRequired || stat.todayReqNightTotal);
  const allotTotal = isDay ? ds.dayAllotted : ds.nightAllotted;
  const shortTotal = stat.totalShort;
  const overTotal = stat.totalOver;
  const breakdown = isDay ? (ds.dayBreakdown || []) : (ds.nightBreakdown || []);

  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" style="max-width:680px;" onclick="event.stopPropagation()">
        <div class="modal-header" style="background:#fef2f2; border-bottom:2px solid #fecaca;">
          <div>
            <h3 style="color:#991b1b; margin:0; font-size:18px; display:flex; align-items:center; gap:8px;">
              <span>🚨</span> ${d.dayName || ds.dayName || ""}, ${dateString} — ${shiftName} Coverage Diagnostics
            </h3>
            <div style="font-size:12px; color:#7f1d1d; margin-top:4px;">
              Staffing Quota: Required <strong>${reqTotal}</strong> • Deficit <strong style="color:#b91c1c;">-${shortTotal} staff</strong> ${overTotal > 0 ? `• Surplus <strong style="color:#2563eb;">+${overTotal} staff</strong>` : ''}
            </div>
          </div>
          <button class="btn btn-secondary" onclick="closeModal()" style="padding:4px 10px; font-weight:bold;">✕</button>
        </div>
        <div class="modal-body" style="max-height:500px; overflow-y:auto; padding:20px;">
          <!-- Overstaffed Roles Section (if any) -->
          ${stat.overRoles.length > 0 ? `
            <div style="background:#eff6ff; border:1.5px solid #93c5fd; border-radius:8px; padding:12px 16px; margin-bottom:16px;">
              <div style="font-weight:800; font-size:14px; color:#1e40af; margin-bottom:8px;">
                🔵 Overstaffed Roles (+${overTotal} Extra Staff Allocated):
              </div>
              <div style="display:flex; flex-direction:column; gap:6px;">
                ${stat.overRoles.map(o => `
                  <div style="background:#ffffff; border:1px solid #bfdbfe; border-radius:6px; padding:6px 12px; font-size:12.5px; display:flex; justify-content:space-between; align-items:center;">
                    <strong style="color:#1d4ed8;">${esc(o.role)}</strong>
                    <span style="background:#dbeafe; color:#1e40af; font-weight:800; padding:2px 8px; border-radius:4px; font-size:11.5px;">+${o.overstaffed} Overstaffed (Required: ${isDay ? o.reqD : o.reqN} | Allotted: ${isDay ? o.allottedD : o.allottedN})</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          <!-- Understaffed Roles Section -->
          <div style="font-size:13px; font-weight:700; color:#475569; margin-bottom:12px;">
            ${stat.shortRoles.length === 0 ? `<span style="color:#15803d;">✅ All role quotas are fully satisfied for this shift.</span>` : `🔴 Role Shortages Breakdown & Diagnostic Reasons:`}
          </div>

          ${stat.shortRoles.length > 0 ? `
            ${stat.shortRoles.map(sr => {
              const b = breakdown.find(item => item.role === sr.role) || { role: sr.role, shortage: sr.shortage, required: isDay ? sr.reqD : sr.reqN, allotted: isDay ? sr.allottedD : sr.allottedN, reasons: [] };
              const directReasons = (b.reasons || []).filter(r => !r.reason.includes("not contracted"));

              return `
                <div style="background:#ffffff; border:1.5px solid #fca5a5; border-radius:8px; padding:14px 16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                  <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #fee2e2; padding-bottom:8px; margin-bottom:10px;">
                    <div style="font-weight:800; font-size:15px; color:#991b1b;">
                      ${esc(sr.role)}: Shortage of -${sr.shortage}
                    </div>
                    <div style="font-size:12px; font-weight:700; background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:4px;">
                      Required: ${isDay ? sr.reqD : sr.reqN} | Allotted: ${isDay ? sr.allottedD : sr.allottedN}
                    </div>
                  </div>

                  <div style="font-size:12px; font-weight:700; color:#334155; margin-bottom:6px;">
                    Candidate Availability Status:
                  </div>

                  ${directReasons.length === 0 ? `
                    <div style="font-size:12px; color:#64748b; font-style:italic; margin-bottom:6px;">
                      No eligible active ${esc(sr.role)} staff available for this shift.
                    </div>
                  ` : `
                    <div style="display:flex; flex-direction:column; gap:6px; margin-bottom:8px;">
                      ${directReasons.map(r => `
                        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px; font-size:12px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                          <span style="font-weight:700; color:#0f172a;">${esc(r.employeeName)}:</span>
                          <span style="color:#b91c1c; font-weight:600;">${esc(r.reason)}</span>
                        </div>
                      `).join('')}
                    </div>
                  `}
                </div>
              `;
            }).join('')}
          ` : ''}
        </div>
        <div class="modal-footer" style="background:#f8fafc; border-top:1px solid #e2e8f0;">
          <button class="btn btn-secondary" onclick="closeModal()">Close Diagnostics</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalContainer").innerHTML = content;
}

function openClashesModal() {
  if (!currentRotaData) return;
  const { clashes, warnings } = currentRotaData;

  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Staffing Shortages & Clashes Audit</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body">
          <div style="font-size:14px; color:#475569; margin-bottom:16px;">
            Per your guidelines, daily staffing quotas are prioritized and <strong>no staff member is overstaffed</strong>. Review the detected shortages and recommended options below:
          </div>

          <h4 style="color:#b91c1c; margin-bottom:10px;">🚨 Daily Staffing Shortages (${clashes.length})</h4>
          ${clashes.length === 0 ? `<div style="color:#15803d; margin-bottom:16px;">Zero staffing shortages! All quotas 100% fulfilled.</div>` : `
            <div style="max-height:220px; overflow-y:auto; margin-bottom:20px;">
              ${clashes.map(c => `
                <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:10px 14px; margin-bottom:8px; font-size:13px;">
                  <div style="font-weight:700; color:#991b1b;">${c.day} ${c.date} (${c.shiftType} Shift)</div>
                  <div style="color:#7f1d1d; margin:4px 0;">Allotted: ${c.allotted} / ${c.required} staff (Deficit: -${c.shortage})</div>
                  <div style="font-weight:600; color:#475569; font-size:12px; margin-top:4px;">Available Solutions:</div>
                  <ul style="padding-left:18px; color:#334155; font-size:12px;">
                    ${c.options.map(o => `<li>${o}</li>`).join('')}
                  </ul>
                </div>
              `).join('')}
            </div>
          `}

          <h4 style="color:#d97706; margin-bottom:10px;">⚠️ Consecutive Work Streak Warnings (${warnings.length})</h4>
          ${warnings.length === 0 ? `<div style="color:#15803d;">All staff work streaks are within 4 consecutive days.</div>` : `
            <div style="max-height:200px; overflow-y:auto;">
              ${warnings.map(w => `
                <div style="background:#fffbeb; border:1px solid #fef3c7; border-radius:6px; padding:10px 14px; margin-bottom:8px; font-size:13px;">
                  <div style="font-weight:700; color:#92400e;">${w.message}</div>
                  ${w.solution ? `<div style="color:#78350f; font-size:12px; margin-top:3px;"><strong>Recommended Solution:</strong> ${w.solution}</div>` : ''}
                </div>
              `).join('')}
            </div>
          `}
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalContainer").innerHTML = content;
}



function openRuleConflictsModal(dateToSelect, initialTab) {
  if (initialTab) {
    currentConflictTab = initialTab;
  }
  if (dateToSelect && typeof dateToSelect === "string") {
    currentConflictSearch = dateToSelect;
    currentConflictOnlyShortages = false;
    if (!initialTab) currentConflictTab = "daily";
  }
  renderRuleConflictsModal();
}

function setConflictTab(tab) {
  currentConflictTab = tab;
  renderRuleConflictsModal();
}

function setContractShortageCategory(cat) {
  currentContractShortageCategory = cat;
  renderRuleConflictsModal();
}

function updateContractShortageSearch(val) {
  currentContractShortageSearch = val;
  renderRuleConflictsModal();
}

function setConflictWeek(wk) {
  currentConflictWeek = wk;
  renderRuleConflictsModal();
}

function setConflictShift(shift) {
  currentConflictShift = shift;
  renderRuleConflictsModal();
}

function toggleConflictOnlyShortages() {
  currentConflictOnlyShortages = !currentConflictOnlyShortages;
  renderRuleConflictsModal();
}

function updateConflictSearch(val) {
  currentConflictSearch = val;
  renderRuleConflictsModal();
}

function renderRuleConflictsModal() {
  if (!currentRotaData) return;
  const { calendarDays, dailyShortages, dailyRequiredTotals, contractShortages } = currentRotaData;
  const days = calendarDays || [];
  const shortagesList = dailyShortages || [];
  const cShortages = contractShortages || [];

  // Filter contract shortages
  const filteredContractShortages = cShortages.filter(c => {
    if (currentContractShortageCategory !== "all" && c.category !== currentContractShortageCategory) return false;
    if (currentContractShortageSearch.trim()) {
      const q = currentContractShortageSearch.trim().toLowerCase();
      const matchName = c.employeeName.toLowerCase().includes(q);
      const matchRole = c.designation.toLowerCase().includes(q);
      const matchReason = c.reason.toLowerCase().includes(q);
      if (!matchName && !matchRole && !matchReason) return false;
    }
    return true;
  });

  const totalContractShortagesCount = cShortages.length;
  const totalContractShortageHours = Math.round(cShortages.reduce((sum, c) => sum + (c.shortageHours || 0), 0) * 10) / 10;

  // Build entries for every day and shift
  const entries = [];
  days.forEach((day, dayIdx) => {
    const weekNum = Math.floor(dayIdx / 7) + 1;
    const ds = shortagesList.find(s => s.date === day.dateString);

    // Day Shift
    const dayReq = ds ? ds.dayRequired : dailyRequiredTotals.day;
    const dayAllot = ds ? ds.dayAllotted : 0;
    const dayShort = ds ? ds.dayShortage : 0;
    const dayBreakdown = ds ? (ds.dayBreakdown || []) : [];

    entries.push({
      date: day.dateString,
      dayName: day.dayName,
      weekNum: weekNum,
      shift: "D",
      shiftName: "Day Shift",
      required: dayReq,
      allotted: dayAllot,
      shortage: dayShort,
      breakdown: dayBreakdown
    });

    // Night Shift
    const nightReq = ds ? ds.nightRequired : dailyRequiredTotals.night;
    const nightAllot = ds ? ds.nightAllotted : 0;
    const nightShort = ds ? ds.nightShortage : 0;
    const nightBreakdown = ds ? (ds.nightBreakdown || []) : [];

    entries.push({
      date: day.dateString,
      dayName: day.dayName,
      weekNum: weekNum,
      shift: "N",
      shiftName: "Night Shift",
      required: nightReq,
      allotted: nightAllot,
      shortage: nightShort,
      breakdown: nightBreakdown
    });
  });

  // Filter entries
  let filtered = entries.filter(e => {
    if (currentConflictWeek !== "all" && String(e.weekNum) !== String(currentConflictWeek)) return false;
    if (currentConflictShift !== "all" && e.shift !== currentConflictShift) return false;
    if (currentConflictOnlyShortages && e.shortage <= 0) return false;

    if (currentConflictSearch.trim()) {
      const q = currentConflictSearch.trim().toLowerCase();
      const matchDate = e.date.toLowerCase().includes(q) || e.dayName.toLowerCase().includes(q);
      const matchRole = e.breakdown.some(b => b.role.toLowerCase().includes(q));
      const matchReason = e.breakdown.some(b => (b.reasons || []).some(r => r.employeeName.toLowerCase().includes(q) || r.reason.toLowerCase().includes(q)));
      if (!matchDate && !matchRole && !matchReason) return false;
    }
    return true;
  });

  const totalShortageShifts = entries.filter(e => e.shortage > 0).length;

  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" style="max-width:980px; width:95vw;" onclick="event.stopPropagation()">
        <div class="modal-header" style="background:#fffbeb; border-bottom:2px solid #fde68a;">
          <div>
            <h3 style="color:#92400e; margin:0; font-size:18px; display:flex; align-items:center; gap:8px;">
              <span>⚖️</span> Staff Shortages & Conflicting Rules Diagnosis
            </h3>
            <div style="font-size:12px; color:#78350f; margin-top:4px;">
              Comprehensive audit of unfulfilled contract hours, non-round shift divisibility, and date-by-date staffing limits.
            </div>
          </div>
          <button class="btn btn-secondary" onclick="closeModal()" style="padding:4px 10px; font-weight:bold;">✕</button>
        </div>

        <div class="modal-body" style="padding:16px 20px;">
          <!-- Top Sub-view Navigation Tabs -->
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #e2e8f0; margin-bottom:14px; padding-bottom:10px; flex-wrap:wrap; gap:10px;">
            <div style="display:flex; gap:8px;">
              <button class="btn ${currentConflictTab === 'contract' ? 'btn-primary' : 'btn-secondary'}" style="padding:6px 14px; font-size:13px; font-weight:700; display:inline-flex; align-items:center; gap:6px;" onclick="setConflictTab('contract')">
                <span>👤</span> Contract Hour Shortages
                <span style="background:${currentConflictTab === 'contract' ? '#ffffff' : '#d97706'}; color:${currentConflictTab === 'contract' ? '#0284c7' : '#ffffff'}; border-radius:10px; padding:1px 7px; font-size:11px; font-weight:800;">
                  ${totalContractShortagesCount}
                </span>
              </button>
              <button class="btn ${currentConflictTab === 'daily' ? 'btn-primary' : 'btn-secondary'}" style="padding:6px 14px; font-size:13px; font-weight:700; display:inline-flex; align-items:center; gap:6px;" onclick="setConflictTab('daily')">
                <span>📅</span> Daily Floor Quota Shortages
                <span style="background:${currentConflictTab === 'daily' ? '#ffffff' : '#dc2626'}; color:${currentConflictTab === 'daily' ? '#0284c7' : '#ffffff'}; border-radius:10px; padding:1px 7px; font-size:11px; font-weight:800;">
                  ${totalShortageShifts}
                </span>
              </button>
            </div>
            <div style="font-size:12px; color:#64748b; font-weight:600;">
              ${currentConflictTab === 'contract' ? `Total Unfulfilled Contract Hours: <strong style="color:#b91c1c;">-${totalContractShortageHours} hrs</strong> across ${totalContractShortagesCount} staff` : `Total Understaffed Shift Slots: <strong style="color:#b91c1c;">${totalShortageShifts} slots</strong> across cycle`}
            </div>
          </div>

          ${currentConflictTab === 'contract' ? `
            <!-- Policy Banner -->
            <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:10px 14px; margin-bottom:14px; display:flex; align-items:flex-start; gap:10px;">
              <span style="font-size:18px;">🛡️</span>
              <div style="font-size:12px; color:#1e40af; line-height:1.5;">
                <strong>Strict Policy: Zero Overtime & Exact Match Enforcement</strong><br>
                Employees are strictly never scheduled for extra hours beyond their monthly contract. For staff whose weekly contracts cannot be tallied cleanly into 11-hour shifts (e.g. 15h or 40h), the engine caps their shifts to prevent unauthorized overtime. Detailed cause diagnosis and shift duration recommendations are listed below.
              </div>
            </div>

            <!-- Contract Shortages Filter Row -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
              <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                <span style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; margin-right:4px;">Cause:</span>
                <button class="btn ${currentContractShortageCategory === 'all' ? 'btn-primary' : 'btn-secondary'}" style="padding:3px 9px; font-size:12px;" onclick="setContractShortageCategory('all')">
                  All Causes (${cShortages.length})
                </button>
                <button class="btn ${currentContractShortageCategory === 'Divisibility & Rounding' ? 'btn-primary' : 'btn-secondary'}" style="padding:3px 9px; font-size:12px;" onclick="setContractShortageCategory('Divisibility & Rounding')">
                  🟡 Divisibility & Rounding (${cShortages.filter(c => c.category === 'Divisibility & Rounding').length})
                </button>
                <button class="btn ${currentContractShortageCategory === 'Zero Overstaffing Limit' ? 'btn-primary' : 'btn-secondary'}" style="padding:3px 9px; font-size:12px;" onclick="setContractShortageCategory('Zero Overstaffing Limit')">
                  🔴 Floor Quota Met (${cShortages.filter(c => c.category === 'Zero Overstaffing Limit').length})
                </button>
                <button class="btn ${currentContractShortageCategory === 'Leave & Availability' ? 'btn-primary' : 'btn-secondary'}" style="padding:3px 9px; font-size:12px;" onclick="setContractShortageCategory('Leave & Availability')">
                  🔵 Leave & Availability (${cShortages.filter(c => c.category === 'Leave & Availability').length})
                </button>
              </div>

              <input type="text" class="form-control" placeholder="Search staff or role..." style="width:200px; padding:5px 8px; font-size:12px;" value="${esc(currentContractShortageSearch)}" oninput="updateContractShortageSearch(this.value)">
            </div>

            <!-- Contract Shortages List -->
            <div style="max-height:480px; overflow-y:auto; padding-right:4px;">
              ${filteredContractShortages.length === 0 ? `
                <div style="text-align:center; padding:32px 16px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; color:#64748b;">
                  <div style="font-size:20px; margin-bottom:6px;">🎉</div>
                  <div style="font-weight:700; color:#0f172a; margin-bottom:4px;">No Contract Shortages Found</div>
                  <div style="font-size:12px;">All staff in this category meet 100% of their contracted hours.</div>
                </div>
              ` : filteredContractShortages.map(c => {
                const pct = c.nominalContractHours > 0 ? Math.min(100, Math.round((c.floorHoursWorked / c.nominalContractHours) * 100)) : 100;
                return `
                  <div style="background:#ffffff; border:1.5px solid ${c.badgeColor}40; border-radius:8px; margin-bottom:12px; box-shadow:0 1px 3px rgba(0,0,0,0.04); overflow:hidden;">
                    <!-- Header -->
                    <div style="padding:10px 16px; background:${c.badgeBg}; border-bottom:1px solid ${c.badgeColor}30; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <strong style="font-size:14px; color:#0f172a;">${esc(c.employeeName)}</strong>
                        <span style="font-size:11px; font-weight:700; color:#475569; background:#ffffff; border:1px solid #cbd5e1; padding:2px 8px; border-radius:4px;">
                          ${esc(c.designation)}
                        </span>
                        <span style="font-size:11px; font-weight:700; color:${c.staffType === 'D' ? '#b45309' : '#4338ca'};">
                          ${c.staffType === 'D' ? '☀️ Day Staff' : '🌙 Night Staff'}
                        </span>
                        <span style="font-size:11px; color:#64748b;">
                          (${c.contractWeeklyHours} hrs/wk contract • ${c.shiftHours} hrs/shift)
                        </span>
                      </div>
                      <div>
                        <span style="background:#fee2e2; color:#b91c1c; font-weight:800; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid #f87171;">
                          ⚠️ Shortage: -${c.shortageHours} hrs
                        </span>
                      </div>
                    </div>

                    <!-- Body -->
                    <div style="padding:12px 16px;">
                      <!-- Metrics Grid -->
                      <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; margin-bottom:10px;">
                        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px;">
                          <div style="font-size:10px; color:#64748b; text-transform:uppercase; font-weight:700;">Nominal Contract Target</div>
                          <div style="font-size:14px; font-weight:800; color:#0f172a;">${c.nominalContractHours} hrs</div>
                        </div>
                        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px;">
                          <div style="font-size:10px; color:#64748b; text-transform:uppercase; font-weight:700;">Floor Hours Worked</div>
                          <div style="font-size:14px; font-weight:800; color:#0369a1;">${c.floorHoursWorked} hrs <span style="font-size:11px; font-weight:600; color:#64748b;">(${c.floorShiftsWorked} shf)</span></div>
                        </div>
                        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px;">
                          <div style="font-size:10px; color:#64748b; text-transform:uppercase; font-weight:700;">Contract Fulfillment</div>
                          <div style="font-size:14px; font-weight:800; color:${pct === 100 ? '#15803d' : '#d97706'};">${pct}%</div>
                        </div>
                        <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:6px 10px;">
                          <div style="font-size:10px; color:#64748b; text-transform:uppercase; font-weight:700;">Shortage Reason</div>
                          <div style="font-size:12px; font-weight:700; color:${c.badgeColor};">${esc(c.category)}</div>
                        </div>
                      </div>

                      <!-- Reason Diagnosis -->
                      <div style="background:#f8fafc; border-left:3.5px solid ${c.badgeColor}; padding:10px 12px; border-radius:0 6px 6px 0; font-size:12px; color:#1e293b; line-height:1.5;">
                        <div style="font-weight:700; color:#0f172a; margin-bottom:3px;">📋 Why This Shortage Happened:</div>
                        ${esc(c.reason)}
                      </div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          ` : `
            <!-- Daily Floor Quota Shortages Filter Controls -->
            <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px 14px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
              <!-- Week Pills -->
              <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                <span style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; margin-right:4px;">Week:</span>
                <button class="btn ${currentConflictWeek === 'all' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setConflictWeek('all')">
                  All 4 Weeks
                </button>
                <button class="btn ${currentConflictWeek === '1' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setConflictWeek('1')">
                  Week 1
                </button>
                <button class="btn ${currentConflictWeek === '2' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setConflictWeek('2')">
                  Week 2
                </button>
                <button class="btn ${currentConflictWeek === '3' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setConflictWeek('3')">
                  Week 3
                </button>
                <button class="btn ${currentConflictWeek === '4' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setConflictWeek('4')">
                  Week 4
                </button>
              </div>

              <!-- Shift & Checkbox Filters -->
              <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <div style="display:flex; gap:4px;">
                  <button class="btn ${currentConflictShift === 'all' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 8px; font-size:12px;" onclick="setConflictShift('all')">
                    All Shifts
                  </button>
                  <button class="btn ${currentConflictShift === 'D' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 8px; font-size:12px;" onclick="setConflictShift('D')">
                    ☀️ Day
                  </button>
                  <button class="btn ${currentConflictShift === 'N' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 8px; font-size:12px;" onclick="setConflictShift('N')">
                    🌙 Night
                  </button>
                </div>

                <label style="font-size:12px; font-weight:600; color:#334155; display:inline-flex; align-items:center; gap:6px; cursor:pointer; margin:0;">
                  <input type="checkbox" ${currentConflictOnlyShortages ? 'checked' : ''} onchange="toggleConflictOnlyShortages()">
                  Only Dates with Shortages (${totalShortageShifts})
                </label>

                <input type="text" class="form-control" placeholder="Search date, role, or staff..." style="width:190px; padding:5px 8px; font-size:12px;" value="${esc(currentConflictSearch)}" oninput="updateConflictSearch(this.value)">
              </div>
            </div>

            <!-- Date-by-Date Shortage List -->
            <div style="max-height:480px; overflow-y:auto; padding-right:4px;">
              ${filtered.length === 0 ? `
                <div style="text-align:center; padding:32px 16px; background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; color:#64748b;">
                  <div style="font-size:20px; margin-bottom:6px;">🎉</div>
                  <div style="font-weight:700; color:#0f172a; margin-bottom:4px;">No Shortages Found</div>
                  <div style="font-size:12px;">All selected dates and shifts meet full staffing quotas.</div>
                </div>
              ` : filtered.map(e => {
                // Group all active reasons on this date
                const fatigueReasons = [];
                const turnaroundReasons = [];
                const leaveReasons = [];
                const trainingReasons = [];
                const prefReasons = [];
                const capReasons = [];

                (e.breakdown || []).forEach(b => {
                  (b.reasons || []).forEach(r => {
                    const item = { employeeName: r.employeeName, role: b.role, reason: r.reason };
                    if (r.reason.includes("Consecutive Days Limit") || r.reason.includes("5-day")) {
                      if (!fatigueReasons.some(x => x.employeeName === r.employeeName)) fatigueReasons.push(item);
                    } else if (r.reason.includes("Turnaround Rest") || r.reason.includes("night shift")) {
                      if (!turnaroundReasons.some(x => x.employeeName === r.employeeName)) turnaroundReasons.push(item);
                    } else if (r.reason.includes("Leave")) {
                      if (!leaveReasons.some(x => x.employeeName === r.employeeName)) leaveReasons.push(item);
                    } else if (r.reason.includes("Training")) {
                      if (!trainingReasons.some(x => x.employeeName === r.employeeName)) trainingReasons.push(item);
                    } else if (r.reason.includes("Unavailability") || r.reason.includes("preference")) {
                      if (!prefReasons.some(x => x.employeeName === r.employeeName)) prefReasons.push(item);
                    } else if (r.reason.includes("Contract Hours Reached") || r.reason.includes("fulfilled")) {
                      if (!capReasons.some(x => x.employeeName === r.employeeName)) capReasons.push(item);
                    }
                  });
                });

                const roleShortages = (e.breakdown || []).filter(b => b.shortage > 0);

                return `
                  <div style="background:#ffffff; border:1.5px solid ${e.shortage > 0 ? '#fca5a5' : '#86efac'}; border-radius:8px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,0.04); overflow:hidden;">
                    <!-- Header -->
                    <div style="padding:10px 16px; background:${e.shortage > 0 ? '#fef2f2' : '#f0fdf4'}; border-bottom:1px solid ${e.shortage > 0 ? '#fee2e2' : '#dcfce7'}; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
                      <div>
                        <span style="font-weight:800; font-size:15px; color:${e.shortage > 0 ? '#991b1b' : '#166534'};">
                          📅 ${e.dayName}, ${formatShortDate(e.date)}
                        </span>
                        <span style="font-size:12px; font-weight:700; margin-left:8px; color:${e.shift === 'D' ? '#b45309' : '#4338ca'}; background:${e.shift === 'D' ? '#fef3c7' : '#e0e7ff'}; padding:2px 8px; border-radius:4px;">
                          ${e.shift === 'D' ? '☀️ Day Shift' : '🌙 Night Shift'}
                        </span>
                        <span style="font-size:11px; color:#64748b; margin-left:6px;">(Week ${e.weekNum})</span>
                      </div>
                      <div>
                        ${e.shortage > 0 ? `
                          <span style="background:#fee2e2; color:#b91c1c; font-weight:800; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid #f87171;">
                            ⚠️ ${e.shortage} Shortage${e.shortage > 1 ? 's' : ''} (${e.allotted} / ${e.required} Allotted)
                          </span>
                        ` : `
                          <span style="background:#dcfce7; color:#15803d; font-weight:800; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid #86efac;">
                            ✅ Fully Staffed (${e.allotted} / ${e.required} Allotted)
                          </span>
                        `}
                      </div>
                    </div>

                    <!-- Body -->
                    <div style="padding:14px 16px;">
                      ${e.shortage > 0 ? `
                        <!-- Section 1: Specific Role Shortages -->
                        <div style="margin-bottom:12px;">
                          <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">
                            • Shortages by Role:
                          </div>
                          <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            ${roleShortages.map(b => `
                              <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:5px 10px; font-size:12px; display:inline-flex; align-items:center; gap:8px;">
                                <strong style="color:#991b1b;">${esc(b.role)}:</strong>
                                <span style="color:#b91c1c; font-weight:800;">-${b.shortage}</span>
                                <span style="color:#64748b; font-size:11px;">(${b.allotted} on duty / ${b.required} required)</span>
                                <button type="button" class="btn btn-secondary" style="padding:2px 8px; font-size:11px; line-height:1.2; font-weight:700;" onclick="closeModal(); switchView('shortage');">
                                  ⚖️ Shortage Manager
                                </button>
                              </div>
                            `).join('')}
                          </div>
                        </div>

                        <!-- Section 2: Why Did These Shortages Happen? (Relevant Rules) -->
                        <div>
                          <div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase; margin-bottom:6px;">
                            • Rules Explaining Why Off-Duty Staff Cannot Cover:
                          </div>
                          <div style="display:flex; flex-direction:column; gap:6px;">
                            ${fatigueReasons.length > 0 ? `
                              <div style="background:#fffbeb; border:1px solid #fef3c7; border-radius:6px; padding:8px 12px; font-size:12px;">
                                <div style="font-weight:700; color:#92400e; margin-bottom:2px;">
                                  🛑 Consecutive Days Limit (Max 4 Days):
                                </div>
                                <div style="color:#78350f;">
                                  ${fatigueReasons.length} staff member(s) already worked 4 days in a row and are resting to prevent a 5-day fatigue streak:
                                  <strong>${fatigueReasons.map(r => esc(r.employeeName)).join(', ')}</strong>.
                                </div>
                              </div>
                            ` : ''}

                            ${turnaroundReasons.length > 0 ? `
                              <div style="background:#e0f2fe; border:1px solid #bae6fd; border-radius:6px; padding:8px 12px; font-size:12px;">
                                <div style="font-weight:700; color:#0369a1; margin-bottom:2px;">
                                  🌙 Night-to-Day Turnaround Rest:
                                </div>
                                <div style="color:#075985;">
                                  ${turnaroundReasons.length} staff worked Sunday night (finishing Monday 8:00 AM) and are sleeping/resting:
                                  <strong>${turnaroundReasons.map(r => esc(r.employeeName)).join(', ')}</strong>.
                                </div>
                              </div>
                            ` : ''}

                            ${leaveReasons.length > 0 ? `
                              <div style="background:#f3e8ff; border:1px solid #e9d5ff; border-radius:6px; padding:8px 12px; font-size:12px;">
                                <div style="font-weight:700; color:#7e22ce; margin-bottom:2px;">
                                  🏖️ Approved Annual Leave:
                                </div>
                                <div style="color:#6b21a8;">
                                  ${leaveReasons.length} staff member(s) away on statutory approved leave:
                                  <strong>${leaveReasons.map(r => esc(r.employeeName)).join(', ')}</strong>.
                                </div>
                              </div>
                            ` : ''}

                            ${trainingReasons.length > 0 ? `
                              <div style="background:#e0e7ff; border:1px solid #c7d2fe; border-radius:6px; padding:8px 12px; font-size:12px;">
                                <div style="font-weight:700; color:#3730a3; margin-bottom:2px;">
                                  🎓 Mandatory Training:
                                </div>
                                <div style="color:#312e81;">
                                  ${trainingReasons.length} staff member(s) attending mandatory care training:
                                  <strong>${trainingReasons.map(r => esc(r.employeeName)).join(', ')}</strong>.
                                </div>
                              </div>
                            ` : ''}

                            ${prefReasons.length > 0 ? `
                              <div style="background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; padding:8px 12px; font-size:12px;">
                                <div style="font-weight:700; color:#334155; margin-bottom:2px;">
                                  📅 Personal Unavailability Request:
                                </div>
                                <div style="color:#475569;">
                                  ${prefReasons.length} staff member(s) requested this specific date off:
                                  <strong>${prefReasons.map(r => esc(r.employeeName)).join(', ')}</strong>.
                                </div>
                              </div>
                            ` : ''}

                            ${capReasons.length > 0 && fatigueReasons.length === 0 && turnaroundReasons.length === 0 && leaveReasons.length === 0 ? `
                              <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px; padding:8px 12px; font-size:12px;">
                                <div style="font-weight:700; color:#475569; margin-bottom:2px;">
                                  🔒 Contract Hours Reached:
                                </div>
                                <div style="color:#64748b;">
                                  Staff in this role have already completed their contracted shift quota for the period (no overstaffing).
                                </div>
                              </div>
                            ` : ''}
                          </div>
                        </div>
                      ` : `
                        <div style="color:#15803d; font-size:13px; font-weight:600;">
                          ✅ Full staffing quota met. All required roles are staffed for this shift.
                        </div>
                      `}
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </div>

        <div class="modal-footer" style="background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:12px; color:#64748b;">
            💡 <em>Policy: Overtime & overstaffing strictly prevented. Non-round contract hour indivisibility diagnosed above.</em>
          </div>
          <button class="btn btn-secondary" onclick="closeModal()">Close Guide</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalContainer").innerHTML = content;
}

/* ==========================================================
   SHORTAGE MANAGEMENT & DRAG-AND-DROP REALLOCATION
   ========================================================= */

let currentShortageWeek = 1;
let currentShortageShift = "all"; // 'all', 'D', 'N'
let currentShortageRoles = []; // [] means all, or array of selected roles
let currentShortageFloors = []; // [] means all, or array of selected floors
let currentShortageSearch = "";
let shortageWorkingRota = null;
let hasUnsavedShortageChanges = false;
let draggedShiftData = null;
let openSlicerMenuId = null;

function toggleSlicerMenu(menuId, e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById(menuId);
  if (!menu) return;
  const isCurrentlyOpen = menu.style.display === "block";
  document.querySelectorAll(".slicer-popup-card").forEach(el => el.style.display = "none");
  if (!isCurrentlyOpen) {
    menu.style.display = "block";
    openSlicerMenuId = menuId;
  } else {
    openSlicerMenuId = null;
  }
}

function toggleShortageFloor(floorName) {
  if (floorName === "all") {
    if (currentShortageFloors.length === 0) {
      currentShortageFloors = ["__none__"];
    } else {
      currentShortageFloors = [];
    }
  } else {
    if (currentShortageFloors.length === 0) {
      const allF = [...new Set((currentRotaData && currentRotaData.balances ? currentRotaData.balances : []).map(b => (b.floor || "").trim()).filter(Boolean))];
      currentShortageFloors = allF.filter(f => f !== floorName);
    } else {
      const idx = currentShortageFloors.indexOf(floorName);
      if (idx >= 0) {
        currentShortageFloors.splice(idx, 1);
        if (currentShortageFloors.length === 0) {
          currentShortageFloors = ["__none__"];
        }
      } else {
        currentShortageFloors = currentShortageFloors.filter(f => f !== "__none__");
        currentShortageFloors.push(floorName);
      }
    }
  }
  openSlicerMenuId = "shortageFloorMenu";
  renderShortageManagementView();
}

function toggleShortageRole(roleName) {
  if (roleName === "all") {
    if (currentShortageRoles.length === 0) {
      currentShortageRoles = ["__none__"];
    } else {
      currentShortageRoles = [];
    }
  } else {
    if (currentShortageRoles.length === 0) {
      const allR = [...new Set((currentRotaData && currentRotaData.balances ? currentRotaData.balances : []).map(b => b.designation))];
      currentShortageRoles = allR.filter(r => r !== roleName);
    } else {
      const idx = currentShortageRoles.indexOf(roleName);
      if (idx >= 0) {
        currentShortageRoles.splice(idx, 1);
        if (currentShortageRoles.length === 0) {
          currentShortageRoles = ["__none__"];
        }
      } else {
        currentShortageRoles = currentShortageRoles.filter(r => r !== "__none__");
        currentShortageRoles.push(roleName);
      }
    }
  }
  openSlicerMenuId = "shortageRoleMenu";
  renderShortageManagementView();
}

function ensureShortageWorkingRota() {
  if (!shortageWorkingRota && currentRotaData && currentRotaData.rota) {
    shortageWorkingRota = JSON.parse(JSON.stringify(currentRotaData.rota));
  }
  return shortageWorkingRota;
}

function setShortageWeek(weekNum) {
  currentShortageWeek = parseInt(weekNum, 10);
  renderShortageManagementView();
}

function setShortageShift(shift) {
  currentShortageShift = shift;
  renderShortageManagementView();
}

function setShortageRole(role) {
  if (role === "all") currentShortageRoles = [];
  else currentShortageRoles = [role];
  renderShortageManagementView();
}

function updateShortageSearch(val) {
  currentShortageSearch = val;
  renderShortageManagementView();
}

function handleShiftDragStart(e, employeeId, fromDate, shiftType, role) {
  draggedShiftData = { employeeId, fromDate, shiftType, role };
  if (e.target) e.target.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  try {
    e.dataTransfer.setData("text/plain", JSON.stringify(draggedShiftData));
  } catch (err) {}
}

function handleShiftDragEnd(e) {
  if (e.target) e.target.classList.remove("dragging");
  document.querySelectorAll(".drop-target-cell").forEach(el => el.classList.remove("drag-over"));
}

function handleShiftDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const cell = e.currentTarget || e.target.closest(".drop-target-cell");
  if (cell) cell.classList.add("drag-over");
}

function handleShiftDragLeave(e) {
  const cell = e.currentTarget || e.target.closest(".drop-target-cell");
  if (cell) cell.classList.remove("drag-over");
}

function handleShiftDrop(e, targetEmpId, toDate) {
  e.preventDefault();
  const cell = e.currentTarget || e.target.closest(".drop-target-cell");
  if (cell) cell.classList.remove("drag-over");

  if (!draggedShiftData) return;
  if (String(draggedShiftData.employeeId) !== String(targetEmpId)) {
    alert("Shifts can only be moved between days for the same staff member.");
    return;
  }
  if (draggedShiftData.fromDate === toDate) return;

  const rota = ensureShortageWorkingRota();
  if (!rota) return;

  const fromRec = rota.find(r => String(r.employeeId) === String(targetEmpId) && r.date === draggedShiftData.fromDate);
  const toRec = rota.find(r => String(r.employeeId) === String(targetEmpId) && r.date === toDate);

  if (!fromRec || !toRec) return;
  if (toRec.status === "L" || toRec.status === "TR") {
    alert("Cannot move shift to an approved annual leave or mandatory training date.");
    return;
  }

  // Move shift
  fromRec.shift = "OFF";
  fromRec.status = "OFF";
  fromRec.coveringRole = "";
  fromRec.isContractFulfillment = false;

  toRec.shift = draggedShiftData.shiftType;
  toRec.status = draggedShiftData.shiftType;
  toRec.coveringRole = fromRec.coveringRole || fromRec.designation || draggedShiftData.role;
  toRec.isContractFulfillment = false;

  hasUnsavedShortageChanges = true;
  draggedShiftData = null;

  renderShortageManagementView();
}

function discardShortageAdjustments() {
  if (!hasUnsavedShortageChanges) return;
  showConfirmModal({
    title: "Discard Unsaved Changes",
    message: "Are you sure you want to discard your manual shift adjustments and revert back to the saved rota?",
    confirmBtnText: "Discard Changes",
    onConfirm: () => {
      shortageWorkingRota = JSON.parse(JSON.stringify(currentRotaData.rota));
      hasUnsavedShortageChanges = false;
      renderShortageManagementView();
    }
  });
}

async function saveShortageAdjustments() {
  if (!shortageWorkingRota) return;
  const btn = document.getElementById("saveShortageBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = "💾 Saving Changes...";
  }

  try {
    const token = getToken() || localStorage.getItem("token");
    const res = await fetch("/api/rota/save-adjustments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ rota: shortageWorkingRota })
    });

    const resText = await res.text();
    let data;
    try {
      data = JSON.parse(resText);
    } catch (parseErr) {
      throw new Error(`Server returned non-JSON response (${res.status} ${res.statusText}): ${resText.substring(0, 150)}`);
    }

    if (!res.ok) {
      alert("Failed to save changes: " + (data.error || "Unknown error"));
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = "💾 Save Changes as Active Rota";
      }
      return;
    }

    currentRotaData = data.rota;
    shortageWorkingRota = JSON.parse(JSON.stringify(data.rota.rota));
    hasUnsavedShortageChanges = false;

    alert("✅ New rota saved successfully! Changes are now active across all schedule views, monthly matrix, print sheets, and Excel exports.");
    renderShortageManagementView();
  } catch (err) {
    console.error("Save error:", err);
    alert("Network error while saving: " + err.message);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = "💾 Save Changes as Active Rota";
    }
  }
}

function checkStaffRuleBreaches(emp, rota, calendarDays) {
  const isMaintenance = (emp.designation || "").toLowerCase().includes("maintenance");
  const maxConsecutive = isMaintenance ? 5 : 4;
  let maxStreak = 0;
  let currentStreak = 0;
  let turnaroundBreach = false;

  calendarDays.forEach((d, idx) => {
    const rec = rota.find(r => String(r.employeeId) === String(emp.employeeId) && r.date === d.dateString);
    if (rec && (rec.shift === "D" || rec.shift === "N")) {
      currentStreak++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    } else {
      currentStreak = 0;
    }

    // Turnaround check: Night on prev date, Day on current date
    if (rec && rec.shift === "D" && idx > 0) {
      const prevRec = rota.find(r => String(r.employeeId) === String(emp.employeeId) && r.date === calendarDays[idx - 1].dateString);
      if (prevRec && prevRec.shift === "N") turnaroundBreach = true;
    }
  });

  const warnings = [];
  if (maxStreak > maxConsecutive) {
    warnings.push(`${maxStreak}-day streak (max ${maxConsecutive})`);
  }
  if (turnaroundBreach) {
    warnings.push("Night-to-Day turnaround");
  }

  return warnings;
}

function renderShortageManagementView() {
  const container = document.getElementById("viewContainer");
  if (!container) return;

  if (!currentRotaData) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:48px 20px;">
        <div style="font-size:36px; margin-bottom:12px;">⚖️</div>
        <h2 style="color:#0f172a; margin-bottom:8px;">No Active Rota Loaded</h2>
        <p style="color:#64748b; font-size:14px; max-width:500px; margin:0 auto 20px auto;">
          Please generate a schedule or load a saved rota in the <strong>Rota Generator</strong> tab before managing shortages and manual adjustments.
        </p>
        <button class="btn btn-primary" onclick="switchView('rota')">📅 Go to Rota Generator</button>
      </div>
    `;
    return;
  }

  const workingRota = ensureShortageWorkingRota();
  const weeks = getRotaWeeks(currentRotaData);
  const week = weeks[currentShortageWeek - 1] || weeks[0];
  const days = week ? week.days : [];
  const calendarDays = currentRotaData.calendarDays || [];
  const balances = currentRotaData.balances || [];
  const reqList = (currentRotaData.requirements && currentRotaData.requirements.length > 0)
    ? currentRotaData.requirements
    : [
        { role_name: 'Dy. Manager', day_required: 1, night_required: 0 },
        { role_name: 'Advanced Team Leader', day_required: 1, night_required: 0 },
        { role_name: 'Clinical Lead', day_required: 1, night_required: 0 },
        { role_name: 'Staff Nurse', day_required: 3, night_required: 3 },
        { role_name: 'Senior Carer', day_required: 3, night_required: 2 },
        { role_name: 'Team Leader', day_required: 1, night_required: 0 },
        { role_name: 'Carer', day_required: 10, night_required: 7 },
        { role_name: 'Wellbeing Staff', day_required: 2, night_required: 0 },
        { role_name: 'Hostes', day_required: 3, night_required: 0 },
        { role_name: 'Maintance Staff', day_required: 2, night_required: 0 },
        { role_name: 'Physiotherapist', day_required: 1, night_required: 0 }
      ];

  const hList = currentRotaData.roleHierarchy || [];
  const roleDaysMap = {};
  hList.forEach(h => {
    roleDaysMap[h.required_role] = parseInt(h.days_per_week, 10) || 7;
  });

  // Calculate live role-wise shortage and overstaffing for each day in this week
  const dayStats = days.map(d => {
    const stat = getShiftRoleStats(d, currentShortageShift, workingRota, currentRotaData.requirements, currentRotaData.roleHierarchy, balances);
    return {
      date: d.dateString,
      dayName: d.dayName,
      shortRoles: stat.shortRoles,
      overRoles: stat.overRoles,
      totalShort: stat.totalShort,
      totalOver: stat.totalOver,
      shortSummary: stat.shortSummary,
      overSummary: stat.overSummary
    };
  });

  const totalWeekShort = dayStats.reduce((sum, s) => sum + s.totalShort, 0);
  const totalWeekOver = dayStats.reduce((sum, s) => sum + s.totalOver, 0);

  // Extract distinct roles and floors
  const allRoles = [...new Set(balances.map(b => b.designation))].sort();
  const allFloors = [...new Set(balances.map(b => (b.floor || "").trim()).filter(Boolean))].sort();
  if (allFloors.length === 0) allFloors.push("Ground Floor", "Top Floor");

  let filteredStaff = balances.filter(st => {
    if (currentShortageShift === "D" && st.staffType !== "D") return false;
    if (currentShortageShift === "N" && st.staffType !== "N") return false;
    if (currentShortageRoles.includes("__none__")) return false;
    if (currentShortageRoles.length > 0 && !currentShortageRoles.includes(st.designation)) return false;
    if (currentShortageFloors.includes("__none__")) return false;
    if (currentShortageFloors.length > 0) {
      const f = (st.floor || "").trim();
      if (!currentShortageFloors.includes(f)) return false;
    }
    if (currentShortageSearch.trim()) {
      const q = currentShortageSearch.trim().toLowerCase();
      const matchName = st.employeeName.toLowerCase().includes(q);
      const matchRole = st.designation.toLowerCase().includes(q);
      if (!matchName && !matchRole) return false;
    }
    return true;
  });

  // Group by Floor and sort by Role Priority
  const floorGroups = groupStaffByFloor(filteredStaff, currentRotaData.rolePriorityMap);

  const content = `
    <!-- Top Action & Info Bar -->
    <div style="background:#ffffff; border:1px solid #cbd5e1; border-radius:10px; padding:16px 20px; margin-bottom:16px; box-shadow:0 1px 3px rgba(0,0,0,0.05); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:14px;">
      <div>
        <h2 style="color:#0b3542; margin:0; font-size:20px; display:flex; align-items:center; gap:8px;">
          <span>⚖️</span> Shortage Management
        </h2>
        <div style="font-size:12.5px; color:#64748b; margin-top:3px;">
          Click and drag shift badges (<strong style="color:#854d0e;">D</strong> / <strong style="color:#1e1b4b;">N</strong>) directly between dates to manually balance shortages and overstaffing.
        </div>
      </div>

      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="discardShortageAdjustments()" ${!hasUnsavedShortageChanges ? 'disabled style="opacity:0.6; cursor:not-allowed;"' : ''}>
          ↺ Discard Changes
        </button>
        <button id="saveShortageBtn" class="btn ${hasUnsavedShortageChanges ? 'btn-primary' : 'btn-secondary'}" onclick="saveShortageAdjustments()" style="${hasUnsavedShortageChanges ? 'background:#16a34a; border-color:#15803d; font-weight:800; box-shadow:0 0 10px rgba(22,163,74,0.4);' : ''}">
          💾 ${hasUnsavedShortageChanges ? 'Save Changes as Active Rota *' : 'Save Changes as Active Rota'}
        </button>
      </div>
    </div>

    <!-- Filter & Week Selector Card (with Multi-Select Floor & Role Slicers) -->
    <div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:8px; padding:12px 18px; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
      <!-- Week Tabs -->
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase; margin-right:4px;">Week:</span>
        ${[1, 2, 3, 4].map(wNum => `
          <button class="btn ${currentShortageWeek === wNum ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 12px; font-size:12.5px; font-weight:700;" onclick="setShortageWeek(${wNum})">
            Week ${wNum}
          </button>
        `).join('')}
      </div>

      <!-- Shift Filter -->
      <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
        <span style="font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase; margin-right:4px;">Shift:</span>
        <button class="btn ${currentShortageShift === 'all' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setShortageShift('all')">
          All Shifts
        </button>
        <button class="btn ${currentShortageShift === 'D' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setShortageShift('D')">
          ☀️ Day Staff
        </button>
        <button class="btn ${currentShortageShift === 'N' ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px; font-size:12px;" onclick="setShortageShift('N')">
          🌙 Night Staff
        </button>
      </div>

      <!-- Multi-Select Slicers (Floor & Role) + Search -->
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <!-- Multi-Select Floor Slicer -->
        <div class="dropdown-slicer" style="position:relative;">
          <button type="button" class="btn btn-secondary" onclick="toggleSlicerMenu('shortageFloorMenu', event)" style="padding:5px 11px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:6px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px;">
            <span>🏢 ${currentShortageFloors.length === 0 ? `All Floors (${allFloors.length})` : currentShortageFloors.includes('__none__') ? 'No Floor' : `${currentShortageFloors.length} Floor${currentShortageFloors.length > 1 ? 's' : ''}`}</span>
            <span style="font-size:9px; color:#64748b;">▼</span>
          </button>
          <div id="shortageFloorMenu" class="slicer-popup-card" onclick="event.stopPropagation()" style="display:none; position:absolute; top:calc(100% + 4px); left:0; z-index:1000; background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.15), 0 8px 10px -6px rgba(0,0,0,0.1); padding:10px 12px; min-width:210px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
              <span style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase;">Filter Floor</span>
              <button type="button" onclick="toggleShortageFloor('all')" style="background:none; border:none; color:#02848f; font-size:11px; font-weight:700; cursor:pointer; padding:0;">${currentShortageFloors.length === 0 ? 'Clear All' : 'Select All'}</button>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto;">
              ${allFloors.map(f => {
                const checked = currentShortageFloors.length === 0 || currentShortageFloors.includes(f);
                const count = balances.filter(b => (b.floor || '').trim() === f).length;
                return `
                  <label class="slicer-checkbox-row" style="display:flex; align-items:center; gap:8px; font-size:12px; color:#1e293b; cursor:pointer; user-select:none; padding:4px 6px; border-radius:4px; transition:background 0.1s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleShortageFloor('${esc(f)}')" style="accent-color:#065463; cursor:pointer;">
                    <span style="flex:1;">${esc(f)}</span>
                    <span style="font-size:10px; color:#64748b; font-weight:600; background:#f1f5f9; padding:1px 6px; border-radius:10px;">${count}</span>
                  </label>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <!-- Multi-Select Role Slicer -->
        <div class="dropdown-slicer" style="position:relative;">
          <button type="button" class="btn btn-secondary" onclick="toggleSlicerMenu('shortageRoleMenu', event)" style="padding:5px 11px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:6px; background:#f8fafc; border:1px solid #cbd5e1; border-radius:6px;">
            <span>👔 ${currentShortageRoles.length === 0 ? `All Roles (${allRoles.length})` : currentShortageRoles.includes('__none__') ? 'No Role' : `${currentShortageRoles.length} Role${currentShortageRoles.length > 1 ? 's' : ''}`}</span>
            <span style="font-size:9px; color:#64748b;">▼</span>
          </button>
          <div id="shortageRoleMenu" class="slicer-popup-card" onclick="event.stopPropagation()" style="display:none; position:absolute; top:calc(100% + 4px); right:0; z-index:1000; background:#ffffff; border:1px solid #cbd5e1; border-radius:8px; box-shadow:0 10px 25px -5px rgba(0,0,0,0.15), 0 8px 10px -6px rgba(0,0,0,0.1); padding:10px 12px; min-width:240px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; border-bottom:1px solid #e2e8f0; padding-bottom:6px;">
              <span style="font-size:11px; font-weight:800; color:#475569; text-transform:uppercase;">Filter Role</span>
              <button type="button" onclick="toggleShortageRole('all')" style="background:none; border:none; color:#02848f; font-size:11px; font-weight:700; cursor:pointer; padding:0;">${currentShortageRoles.length === 0 ? 'Clear All' : 'Select All'}</button>
            </div>
            <div style="display:flex; flex-direction:column; gap:4px; max-height:220px; overflow-y:auto;">
              ${allRoles.map(r => {
                const checked = currentShortageRoles.length === 0 || currentShortageRoles.includes(r);
                const count = balances.filter(b => b.designation === r).length;
                return `
                  <label class="slicer-checkbox-row" style="display:flex; align-items:center; gap:8px; font-size:12px; color:#1e293b; cursor:pointer; user-select:none; padding:4px 6px; border-radius:4px; transition:background 0.1s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='transparent'">
                    <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleShortageRole('${esc(r)}')" style="accent-color:#065463; cursor:pointer;">
                    <span style="flex:1;">${esc(r)}</span>
                    <span style="font-size:10px; color:#64748b; font-weight:600; background:#f1f5f9; padding:1px 6px; border-radius:10px;">${count}</span>
                  </label>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <!-- Search Input -->
        <input type="text" class="form-control" placeholder="🔍 Search staff..." style="width:150px; padding:5px 8px; font-size:12px;" value="${esc(currentShortageSearch)}" oninput="updateShortageSearch(this.value)">
      </div>
    </div>

    <!-- Live Status Banner -->
    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; font-size:12.5px; color:#475569; flex-wrap:wrap; gap:8px;">
      <div style="display:flex; gap:12px; align-items:center;">
        <span>Showing <strong>${filteredStaff.length}</strong> staff in Week ${currentShortageWeek}</span>
        <span style="border-left:1px solid #cbd5e1; height:14px;"></span>
        <span style="color:#b91c1c; font-weight:700;">🔴 Total Shortages: -${totalWeekShort}</span>
        <span style="border-left:1px solid #cbd5e1; height:14px;"></span>
        <span style="color:#3730a3; font-weight:700;">🔵 Total Overstaffed: +${totalWeekOver}</span>
      </div>
      ${hasUnsavedShortageChanges ? `
        <span style="background:#fef3c7; color:#b45309; font-weight:800; font-size:11.5px; padding:3px 10px; border-radius:12px; border:1px solid #fde68a;">
          * Unsaved changes staged (click "Save Changes as Active Rota" to commit)
        </span>
      ` : `
        <span style="color:#15803d; font-size:11.5px; font-weight:600;">
          All changes synchronized with official rota.
        </span>
      `}
    </div>

    <!-- Main Drag & Drop Grid with Freezed Top Shortage Row -->
    <div class="table-responsive" style="max-height:700px; overflow-x:hidden; overflow-y:auto; border-radius:8px; border:1.5px solid #cbd5e1; box-shadow:0 2px 4px rgba(0,0,0,0.05); width:100%;">
      <table class="matrix-table" style="background:#ffffff; border-collapse:separate; border-spacing:0; width:100%; table-layout:fixed;">
        <thead class="shortage-sticky-header">
          <tr style="background:#f8fafc; border-bottom:2px solid #cbd5e1;">
            <th class="matrix-sticky-name-th" style="width:15%; padding:8px 8px; border-right:1px solid #cbd5e1; background:#f8fafc; vertical-align:middle; font-size:11.5px; font-weight:800; color:#334155; text-transform:uppercase; letter-spacing:0.4px;">
              Staff Name
            </th>
            <th class="matrix-sticky-role-th" style="width:9.5%; padding:8px 6px; border-right:1px solid #cbd5e1; background:#f8fafc; vertical-align:middle; font-size:11.5px; font-weight:800; color:#334155; text-transform:uppercase; letter-spacing:0.4px;">
              Role
            </th>
            <th style="width:8.5%; text-align:center; padding:8px 4px; border-right:2px solid #0b3542; background:#f8fafc; vertical-align:middle; font-size:11.5px; font-weight:800; color:#334155; text-transform:uppercase; letter-spacing:0.4px;">
              Contract Target
            </th>

            <!-- 7 Day Columns with Freezed Top Shortage Row (Optimized Widths) -->
            ${days.map((d, idx) => {
              const stat = dayStats[idx];
              const isWeekend = d.isWeekend;
              return `
                <th style="text-align:center; width:9.57%; padding:6px 3px; border-right:1px solid #cbd5e1; background:${isWeekend ? '#f1f5f9' : '#f8fafc'}; vertical-align:top;">
                  <div style="font-size:12px; font-weight:800; color:#0f172a;">
                    ${d.dayName.substring(0, 3)}
                  </div>
                  <div style="font-size:10.5px; color:#64748b; margin-bottom:4px;">
                    ${formatShortDate(d.dateString)}
                  </div>

                  <!-- Freezed Role-Wise Shortage & Overstaffing Badges Row -->
                  ${stat.totalShort > 0 && stat.totalOver > 0 ? `
                    <div style="display:flex; flex-direction:column; gap:2px; align-items:center;">
                      <div style="display:flex; gap:2px; justify-content:center; flex-wrap:wrap;">
                        <span class="badge-shortage" title="${esc(stat.shortSummary)}">Short: -${stat.totalShort}</span>
                        <span class="badge-overstaffed" title="${esc(stat.overSummary)}">Over: +${stat.totalOver}</span>
                      </div>
                      <div style="font-size:9.5px; line-height:1.35; margin-top:4px; width:100%; text-align:left; padding:3px 4px; background:#ffffff; border-radius:4px; border:1px solid #e2e8f0; box-sizing:border-box;">
                        ${stat.shortRoles.map(r => `
                          <div style="color:#b91c1c; font-weight:700; display:flex; align-items:center; gap:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="-${r.shortage} ${esc(r.role)}">
                            <span style="font-size:7px; flex-shrink:0;">🔴</span>
                            <span style="flex-shrink:0;">-${r.shortage}</span>
                            <span style="overflow:hidden; text-overflow:ellipsis;">${esc(r.role)}</span>
                          </div>
                        `).join('')}
                        ${stat.overRoles.map(r => `
                          <div style="color:#2563eb; font-weight:700; display:flex; align-items:center; gap:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="+${r.overstaffed} ${esc(r.role)}">
                            <span style="font-size:7px; flex-shrink:0;">🔵</span>
                            <span style="flex-shrink:0;">+${r.overstaffed}</span>
                            <span style="overflow:hidden; text-overflow:ellipsis;">${esc(r.role)}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : stat.totalShort > 0 ? `
                    <div style="display:flex; flex-direction:column; gap:2px; align-items:center;">
                      <span class="badge-shortage" title="${esc(stat.shortSummary)}">Short: -${stat.totalShort}</span>
                      <div style="font-size:9.5px; line-height:1.35; margin-top:4px; width:100%; text-align:left; padding:3px 4px; background:#ffffff; border-radius:4px; border:1px solid #e2e8f0; box-sizing:border-box;">
                        ${stat.shortRoles.map(r => `
                          <div style="color:#b91c1c; font-weight:700; display:flex; align-items:center; gap:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="-${r.shortage} ${esc(r.role)}">
                            <span style="font-size:7px; flex-shrink:0;">🔴</span>
                            <span style="flex-shrink:0;">-${r.shortage}</span>
                            <span style="overflow:hidden; text-overflow:ellipsis;">${esc(r.role)}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : stat.totalOver > 0 ? `
                    <div style="display:flex; flex-direction:column; gap:2px; align-items:center;">
                      <span class="badge-overstaffed" title="${esc(stat.overSummary)}">Over: +${stat.totalOver}</span>
                      <div style="font-size:9.5px; line-height:1.35; margin-top:4px; width:100%; text-align:left; padding:3px 4px; background:#ffffff; border-radius:4px; border:1px solid #e2e8f0; box-sizing:border-box;">
                        ${stat.overRoles.map(r => `
                          <div style="color:#2563eb; font-weight:700; display:flex; align-items:center; gap:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="+${r.overstaffed} ${esc(r.role)}">
                            <span style="font-size:7px; flex-shrink:0;">🔵</span>
                            <span style="flex-shrink:0;">+${r.overstaffed}</span>
                            <span style="overflow:hidden; text-overflow:ellipsis;">${esc(r.role)}</span>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  ` : `
                    <div>
                      <span class="badge-met" title="All role quotas met">✅ Met</span>
                    </div>
                  `}
                </th>
              `;
            }).join('')}
          </tr>
        </thead>
        <tbody>
          ${filteredStaff.length === 0 ? `
            <tr>
              <td colspan="${3 + days.length}" style="text-align:center; padding:36px; color:#64748b; font-style:italic;">
                No staff members match the selected filters.
              </td>
            </tr>
          ` : floorGroups.map(grp => {
            if (grp.staff.length === 0) return '';
            return `
              ${grp.showHeader ? `
                <tr style="background:${grp.bg}; color:${grp.color}; font-weight:800; font-size:12px; border-top:2px solid #cbd5e1; border-bottom:1px solid ${grp.color}30;">
                  <td colspan="${3 + days.length}" style="padding:7px 12px; letter-spacing:0.3px;">
                    ${grp.label} &nbsp;•&nbsp; <span style="font-size:11px; font-weight:600; opacity:0.85;">${grp.staff.length} Staff Members</span>
                  </td>
                </tr>
              ` : ''}

              ${grp.staff.map(st => {
                const targetShifts = st.weeklyTargets ? (st.weeklyTargets[week.num - 1] || Math.round((st.contractHours || 44)/11)) : Math.round((st.contractHours || 44)/11);
                const warnings = checkStaffRuleBreaches(st, workingRota, calendarDays);

                return `
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <!-- Staff Name (Sticky Left) -->
                    <td class="matrix-sticky-name" style="padding:6px 8px; border-right:1px solid #e2e8f0;">
                      <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
                        <strong style="color:#0f172a; font-size:12.5px;">${esc(st.employeeName)}</strong>
                        ${warnings.length > 0 ? `
                          <span title="Rule Warning: ${esc(warnings.join(', '))}" style="color:#b45309; background:#fef3c7; border:1px solid #fde68a; font-size:9.5px; font-weight:800; padding:1px 3px; border-radius:3px; cursor:help;">
                            ⚠️ ${warnings[0]}
                          </span>
                        ` : ''}
                      </div>
                    </td>

                    <!-- Role (Sticky Left) -->
                    <td class="matrix-sticky-role" style="padding:6px 8px; border-right:1px solid #e2e8f0; font-size:12px; color:#334155;">
                      ${esc(st.designation)}
                    </td>

                    <!-- Contract Target -->
                    <td style="text-align:center; padding:6px 4px; border-right:2px solid #0b3542; font-size:11.5px; color:#475569; white-space:nowrap;">
                      <strong>${st.contractWeeklyHours || st.contractHours}h</strong>
                      <span style="color:#059669; font-weight:700; margin-left:3px;">(Tgt: ${targetShifts} shf)</span>
                    </td>

                    <!-- 7 Day Shift Cells (Interactive Drag & Drop) -->
                    ${days.map(d => {
                      const rec = workingRota.find(r => String(r.employeeId) === String(st.employeeId) && r.date === d.dateString);
                      const status = rec ? rec.status : "OFF";
                      const isWorking = status === "D" || status === "N";
                      const isLocked = status === "L" || status === "TR";

                      if (isWorking) {
                        return `
                          <td style="text-align:center; padding:4px 3px; border-right:1px solid #f1f5f9; vertical-align:middle;">
                            <div class="drag-shift-pill status-${rec.shift} ${rec.isContractFulfillment ? 'contract-fulfillment-indicator' : ''}"
                                 draggable="true"
                                 ondragstart="handleShiftDragStart(event, '${st.employeeId}', '${d.dateString}', '${rec.shift}', '${esc(st.designation)}')"
                                 ondragend="handleShiftDragEnd(event)"
                                 title="${rec.isContractFulfillment ? 'Overstaffed slot: Allotted to fulfill contract hours. Drag to move to another day.' : 'Click and drag to move shift'}">
                              ${rec.shift}
                            </div>
                          </td>
                        `;
                      } else if (isLocked) {
                        return `
                          <td style="text-align:center; padding:4px 3px; border-right:1px solid #f1f5f9; vertical-align:middle;">
                            <span class="status-pill status-${status}" style="font-size:11px;" title="${status === 'L' ? 'Approved Annual Leave (Locked)' : 'Mandatory Training (Locked)'}">
                              ${status}
                            </span>
                          </td>
                        `;
                      } else {
                        // OFF Drop Target Cell
                        return `
                          <td style="text-align:center; padding:3px 2px; border-right:1px solid #f1f5f9; vertical-align:middle;">
                            <div class="drop-target-cell"
                                 ondragover="handleShiftDragOver(event)"
                                 ondragleave="handleShiftDragLeave(event)"
                                 ondrop="handleShiftDrop(event, '${st.employeeId}', '${d.dateString}')">
                              <span class="status-pill status-OFF" style="opacity:0.35; font-size:11px;">OFF</span>
                            </div>
                          </td>
                        `;
                      }
                    }).join('')}
                  </tr>
                `;
              }).join('')}
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = content;

  if (openSlicerMenuId) {
    const el = document.getElementById(openSlicerMenuId);
    if (el) el.style.display = "block";
  }
}

function downloadBlob(buffer, filename) {
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

async function exportRotaToExcel() {
  if (!currentRotaData) {
    alert("Please generate or load a rota first.");
    return;
  }
  const rota = currentRotaData.rota || [];
  const balances = currentRotaData.balances || [];
  const calendarDays = currentRotaData.calendarDays || [];
  const weeks = getRotaWeeks(currentRotaData);
  const periodLabel = currentRotaData.periodLabel || "Cycle";
  const dailyRequiredTotals = currentRotaData.dailyRequiredTotals || { day: 16, night: 10 };
  const safePeriod = periodLabel.replace(/[^a-zA-Z0-9]/g, "_");

  // 1. PRIMARY EXPORT: Use ExcelJS for executive styling (Navy #0b3542, cell badges, zebra rows)
  if (window.ExcelJS) {
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Care Home Rota Management Platform";
      workbook.created = new Date();

      const applyHeaderStyle = (row, bgColor = "FF0B3542", fontColor = "FFFFFFFF") => {
        row.height = 26;
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
          cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: fontColor } };
          cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            left: { style: 'thin', color: { argb: 'FFCBD5E1' } },
            bottom: { style: 'medium', color: { argb: bgColor } },
            right: { style: 'thin', color: { argb: 'FFCBD5E1' } }
          };
        });
      };

      const applyDataRowStyle = (row, isEven = false) => {
        row.height = 20;
        const rowBg = isEven ? "FFF8FAFC" : "FFFFFFFF";
        row.eachCell((cell, colNumber) => {
          cell.font = { name: 'Segoe UI', size: 9.5, color: { argb: 'FF0F172A' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowBg } };
          cell.alignment = { vertical: 'middle', horizontal: colNumber <= 2 ? 'left' : 'center' };
          cell.border = {
            top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
            right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
          };

          const val = String(cell.value || '').trim();
          if (val === 'D') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF08A' } };
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF713F12' } };
          } else if (val === 'N') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
          } else if (val === 'OFF') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
            cell.font = { name: 'Segoe UI', size: 9.5, color: { argb: 'FF94A3B8' } };
          } else if (val === 'L') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF991B1B' } };
          } else if (val === 'TR') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF1E40AF' } };
          }
        });
      };

      if (rotaSubView === "weekly") {
        // 8 Separate Sheets: Week 1 - Day, Week 1 - Night, Week 2 - Day, Week 2 - Night, etc.
        const staffList = [...balances].sort((a, b) => a.designation.localeCompare(b.designation) || a.employeeName.localeCompare(b.employeeName));

        weeks.forEach(w => {
          // 1. DAY SHIFT SHEET FOR THIS WEEK
          const wsDay = workbook.addWorksheet(`Week ${w.num} - Day`, { views: [{ showGridLines: true }] });

          // Title banner
          wsDay.mergeCells('A1:K1');
          const titleCellDay = wsDay.getCell('A1');
          titleCellDay.value = `CARE HOME ROTA — WEEK ${w.num} DAY SHIFT SCHEDULE (${w.days[0].dateString} to ${w.days[6].dateString})`;
          titleCellDay.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3542' } };
          titleCellDay.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
          titleCellDay.alignment = { vertical: 'middle', horizontal: 'center' };
          wsDay.getRow(1).height = 30;

          // Header row
          const headerRowDay = wsDay.getRow(3);
          headerRowDay.values = [
            "Staff Name",
            "Role",
            "Contract Target",
            `${w.days[0].dayName.substring(0,3)} (${formatShortDate(w.days[0].dateString)})`,
            `${w.days[1].dayName.substring(0,3)} (${formatShortDate(w.days[1].dateString)})`,
            `${w.days[2].dayName.substring(0,3)} (${formatShortDate(w.days[2].dateString)})`,
            `${w.days[3].dayName.substring(0,3)} (${formatShortDate(w.days[3].dateString)})`,
            `${w.days[4].dayName.substring(0,3)} (${formatShortDate(w.days[4].dateString)})`,
            `${w.days[5].dayName.substring(0,3)} (${formatShortDate(w.days[5].dateString)})`,
            `${w.days[6].dayName.substring(0,3)} (${formatShortDate(w.days[6].dateString)})`,
            "Day Shifts Worked"
          ];
          applyHeaderStyle(headerRowDay, "FF0B3542", "FFFFFFFF");

          wsDay.columns = [
            { width: 26 },
            { width: 18 },
            { width: 16 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 18 }
          ];

          const dayStaffList = staffList.filter(st => {
            if (st.staffType === "D") return true;
            return w.days.some(d => {
              const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
              return rec && rec.shift === "D";
            });
          });

          let dayRowCounter = 0;
          groupStaffByFloor(dayStaffList, currentRotaData.rolePriorityMap).forEach(grp => {
            if (grp.staff.length === 0) return;
            if (grp.showHeader) {
              const floorSepRow = wsDay.addRow([grp.label, "", "", ...w.days.map(() => ""), ""]);
              floorSepRow.height = 22;
              floorSepRow.eachCell(cell => {
                cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: (grp.color || "#0369a1").replace('#', 'FF') } };
                cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: (grp.bg || "#e0f2fe").replace('#', 'FF') } };
                cell.alignment = { vertical: 'middle', horizontal: 'left' };
              });
            }

            grp.staff.forEach(st => {
              let dayShiftsWorked = 0;
              const daysVals = w.days.map(d => {
                const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                const s = rec ? rec.status : "OFF";
                if (s === "D") dayShiftsWorked++;
                return s;
              });

              const row = wsDay.addRow([
                st.employeeName,
                st.designation,
                `${st.contractHours}h`,
                ...daysVals,
                dayShiftsWorked
              ]);
              applyDataRowStyle(row, dayRowCounter % 2 === 1);
              dayRowCounter++;
            });
          });

          // Day Quota summaries
          wsDay.addRow([]);
          const dayReqRow = wsDay.addRow([
            "Required Day Staff", "", "",
            ...w.days.map(() => dailyRequiredTotals.day),
            ""
          ]);
          dayReqRow.height = 20;
          dayReqRow.eachCell(cell => {
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF475569' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
          });

          const dayAllotRow = wsDay.addRow([
            "Allotted Day Staff", "", "",
            ...w.days.map(d => rota.filter(r => r.date === d.dateString && r.shift === "D" && r.status !== "TR").length),
            ""
          ]);
          dayAllotRow.height = 20;
          dayAllotRow.eachCell(cell => {
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF0F172A' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
          });

          // 2. NIGHT SHIFT SHEET FOR THIS WEEK
          const wsNight = workbook.addWorksheet(`Week ${w.num} - Night`, { views: [{ showGridLines: true }] });

          // Title banner
          wsNight.mergeCells('A1:K1');
          const titleCellNight = wsNight.getCell('A1');
          titleCellNight.value = `CARE HOME ROTA — WEEK ${w.num} NIGHT SHIFT SCHEDULE (${w.days[0].dateString} to ${w.days[6].dateString})`;
          titleCellNight.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E1B4B' } };
          titleCellNight.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
          titleCellNight.alignment = { vertical: 'middle', horizontal: 'center' };
          wsNight.getRow(1).height = 30;

          // Header row
          const headerRowNight = wsNight.getRow(3);
          headerRowNight.values = [
            "Staff Name",
            "Role",
            "Contract Target",
            `${w.days[0].dayName.substring(0,3)} (${formatShortDate(w.days[0].dateString)})`,
            `${w.days[1].dayName.substring(0,3)} (${formatShortDate(w.days[1].dateString)})`,
            `${w.days[2].dayName.substring(0,3)} (${formatShortDate(w.days[2].dateString)})`,
            `${w.days[3].dayName.substring(0,3)} (${formatShortDate(w.days[3].dateString)})`,
            `${w.days[4].dayName.substring(0,3)} (${formatShortDate(w.days[4].dateString)})`,
            `${w.days[5].dayName.substring(0,3)} (${formatShortDate(w.days[5].dateString)})`,
            `${w.days[6].dayName.substring(0,3)} (${formatShortDate(w.days[6].dateString)})`,
            "Night Shifts Worked"
          ];
          applyHeaderStyle(headerRowNight, "FF1E1B4B", "FFFFFFFF");

          wsNight.columns = [
            { width: 26 },
            { width: 18 },
            { width: 16 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 14 },
            { width: 18 }
          ];

          const nightStaffList = staffList.filter(st => {
            if (st.staffType === "N") return true;
            return w.days.some(d => {
              const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
              return rec && rec.shift === "N";
            });
          });

          sortStaffByPriority(nightStaffList, currentRotaData.rolePriorityMap).forEach((st, idx) => {
            let nightShiftsWorked = 0;
            const daysVals = w.days.map(d => {
              const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
              const s = rec ? rec.status : "OFF";
              if (s === "N") nightShiftsWorked++;
              return s;
            });

            const row = wsNight.addRow([
              st.employeeName,
              st.designation,
              `${st.contractHours}h`,
              ...daysVals,
              nightShiftsWorked
            ]);
            applyDataRowStyle(row, idx % 2 === 1);
          });

          // Night Quota summaries
          wsNight.addRow([]);
          const nightReqRow = wsNight.addRow([
            "Required Night Staff", "", "",
            ...w.days.map(() => dailyRequiredTotals.night),
            ""
          ]);
          nightReqRow.height = 20;
          nightReqRow.eachCell(cell => {
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF475569' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
          });

          const nightAllotRow = wsNight.addRow([
            "Allotted Night Staff", "", "",
            ...w.days.map(d => rota.filter(r => r.date === d.dateString && r.shift === "N").length),
            ""
          ]);
          nightAllotRow.height = 20;
          nightAllotRow.eachCell(cell => {
            cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FF0F172A' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
          });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        downloadBlob(buffer, `CareHome_Weekly_Rota_${safePeriod}.xlsx`);
        return;

      } else if (rotaSubView === "monthly") {
        // Monthly 28-day staff schedule
        const ws = workbook.addWorksheet("Monthly Staff Matrix", { views: [{ showGridLines: true }] });

        ws.mergeCells('A1:AI1');
        const titleCell = ws.getCell('A1');
        titleCell.value = `CARE HOME ROTA — STAFF-WISE 28-DAY MONTHLY MATRIX (${periodLabel})`;
        titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3542' } };
        titleCell.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
        ws.getRow(1).height = 30;

        const headerRow = ws.getRow(3);
        const headers = [
          "Staff Name",
          "Role",
          "Contract Target",
          ...calendarDays.map(d => `${d.dayName.substring(0,3)} ${formatShortDate(d.dateString)}`),
          "Day Shifts",
          "Night Shifts",
          "Total Shifts",
          "Hours Worked",
          "Fulfillment Status"
        ];
        headerRow.values = headers;
        applyHeaderStyle(headerRow, "FF0B3542", "FFFFFFFF");

        ws.columns = [
          { width: 26 },
          { width: 18 },
          { width: 16 },
          ...calendarDays.map(() => ({ width: 10 })),
          { width: 12 },
          { width: 12 },
          { width: 14 },
          { width: 14 },
          { width: 24 }
        ];

        const staffList = [...balances];
        let mRowIdx = 0;
        groupStaffByFloor(staffList, currentRotaData.rolePriorityMap).forEach(grp => {
          if (grp.staff.length === 0) return;
          if (grp.showHeader) {
            const floorSepRow = ws.addRow([grp.label, "", "", ...calendarDays.map(() => ""), "", "", "", "", ""]);
            floorSepRow.height = 24;
            floorSepRow.eachCell(cell => {
              cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: (grp.color || "#0369a1").replace('#', 'FF') } };
              cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: (grp.bg || "#e0f2fe").replace('#', 'FF') } };
              cell.alignment = { vertical: 'middle', horizontal: 'left' };
            });
          }

          grp.staff.forEach(st => {
            let dayCount = 0;
            let nightCount = 0;
            const daysStatus = calendarDays.map(d => {
              const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
              const s = rec ? rec.status : "OFF";
              if (s === "D") dayCount++;
              if (s === "N") nightCount++;
              return s;
            });

            const row = ws.addRow([
              st.employeeName,
              st.designation,
              `${st.contractHours}h`,
              ...daysStatus,
              dayCount,
              nightCount,
              st.floorShiftsWorked,
              `${st.floorHoursWorked}h`,
              st.contractStatus
            ]);
            applyDataRowStyle(row, mRowIdx % 2 === 1);
            mRowIdx++;
          });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        downloadBlob(buffer, `CareHome_Staff_Monthly_Matrix_${safePeriod}.xlsx`);
        return;

      } else if (rotaSubView === "balances") {
        // Contract Hours and Balances
        const ws = workbook.addWorksheet("Contract Balances", { views: [{ showGridLines: true }] });

        ws.mergeCells('A1:L1');
        const titleCell = ws.getCell('A1');
        titleCell.value = `CARE HOME ROTA — CONTRACT HOURS & BALANCES SUMMARY (${periodLabel})`;
        titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B3542' } };
        titleCell.font = { name: 'Segoe UI', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
        titleCell.alignment = { vertical: 'middle', horizontal: 'center' };
        ws.getRow(1).height = 30;

        const headerRow = ws.getRow(3);
        headerRow.values = [
          "Staff Name",
          "Role",
          "Contract Target",
          "Shift Duration",
          "Required Shifts",
          "Shifts Worked",
          "Floor Hours Worked",
          "Leave Days",
          "Leave Credit (hrs)",
          "Total Accounted Hours",
          "Balance Remaining",
          "Contract Fulfillment Status"
        ];
        applyHeaderStyle(headerRow, "FF0B3542", "FFFFFFFF");

        ws.columns = [
          { width: 26 },
          { width: 18 },
          { width: 16 },
          { width: 14 },
          { width: 16 },
          { width: 16 },
          { width: 18 },
          { width: 14 },
          { width: 16 },
          { width: 22 },
          { width: 18 },
          { width: 26 }
        ];

        let totalTarget = 0;
        let totalWorked = 0;
        let totalLeave = 0;

        balances.forEach((b, idx) => {
          totalTarget += b.contractHours;
          totalWorked += b.floorHoursWorked;
          totalLeave += b.leaveDedHours;

          const row = ws.addRow([
            b.employeeName,
            b.designation,
            `${b.contractHours}h`,
            `${b.shiftHours}h`,
            Math.ceil(b.netTargetHours / b.shiftHours),
            b.floorShiftsWorked,
            `${b.floorHoursWorked}h`,
            b.leaveDays,
            `${b.leaveDedHours}h`,
            `${b.floorHoursWorked + b.leaveDedHours}h`,
            `${b.balanceRemaining}h`,
            b.contractStatus
          ]);
          applyDataRowStyle(row, idx % 2 === 1);
        });

        const totalRow = ws.addRow([
          "TOTALS (All 61 Staff)",
          "All Roles",
          `${totalTarget}h Target`,
          "",
          "",
          "",
          `${totalWorked}h Worked`,
          "",
          `${totalLeave}h Leave`,
          `${totalWorked + totalLeave}h Accounted`,
          "0h Deficit",
          "100% Contract Fulfilled"
        ]);
        totalRow.height = 24;
        totalRow.eachCell(cell => {
          cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF0F172A' } };
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.border = { top: { style: 'medium', color: { argb: 'FF15803D' } }, bottom: { style: 'medium', color: { argb: 'FF15803D' } } };
        });

        const buffer = await workbook.xlsx.writeBuffer();
        downloadBlob(buffer, `CareHome_Contract_Hours_Balances_${safePeriod}.xlsx`);
        return;
      }
    } catch (err) {
      console.warn("ExcelJS error, falling back to SheetJS:", err);
    }
  }

  // 2. FALLBACK EXPORT: SheetJS (XLSX)
  const wb = XLSX.utils.book_new();

  if (rotaSubView === "weekly") {
    const staffList = [...balances];

    weeks.forEach(w => {
      // 1. Day Sheet
      const dayStaffList = staffList.filter(st => {
        if (st.staffType === "D") return true;
        return w.days.some(d => {
          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
          return rec && rec.shift === "D";
        });
      });

      const dayRows = [];
      groupStaffByFloor(dayStaffList, currentRotaData.rolePriorityMap).forEach(grp => {
        if (grp.staff.length === 0) return;
        if (grp.showHeader) {
          dayRows.push({
            "Staff Name": `--- ${grp.label} ---`,
            "Role": `${grp.staff.length} Staff`,
            "Contract Target": ""
          });
        }
        grp.staff.forEach(st => {
          let dayShiftsWorked = 0;
          const row = {
            "Staff Name": st.employeeName,
            "Role": st.designation,
            "Contract Target": `${st.contractHours}h`
          };
          w.days.forEach(d => {
            const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
            const s = rec ? rec.status : "OFF";
            if (s === "D") dayShiftsWorked++;
            row[`${d.dayName.substring(0,3)} (${formatShortDate(d.dateString)})`] = s;
          });
          row["Day Shifts Worked"] = dayShiftsWorked;
          dayRows.push(row);
        });
      });
      const wsDay = XLSX.utils.json_to_sheet(dayRows);
      wsDay['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, wsDay, `Week ${w.num} - Day`);

      // 2. Night Sheet
      const nightStaffList = staffList.filter(st => {
        if (st.staffType === "N") return true;
        return w.days.some(d => {
          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
          return rec && rec.shift === "N";
        });
      });

      const nightRows = sortStaffByPriority(nightStaffList, currentRotaData.rolePriorityMap).map(st => {
        let nightShiftsWorked = 0;
        const row = {
          "Staff Name": st.employeeName,
          "Role": st.designation,
          "Contract Target": `${st.contractHours}h`
        };
        w.days.forEach(d => {
          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
          const s = rec ? rec.status : "OFF";
          if (s === "N") nightShiftsWorked++;
          row[`${d.dayName.substring(0,3)} (${formatShortDate(d.dateString)})`] = s;
        });
        row["Night Shifts Worked"] = nightShiftsWorked;
        return row;
      });
      const wsNight = XLSX.utils.json_to_sheet(nightRows);
      wsNight['!cols'] = [{ wch: 26 }, { wch: 18 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, wsNight, `Week ${w.num} - Night`);
    });
    XLSX.writeFile(wb, `CareHome_Weekly_Rota_${safePeriod}.xlsx`);

  } else if (rotaSubView === "monthly") {
    const rows = [];
    groupStaffByFloor(balances, currentRotaData.rolePriorityMap).forEach(grp => {
      if (grp.staff.length === 0) return;
      if (grp.showHeader) {
        rows.push({
          "Staff Name": `--- ${grp.label} ---`,
          "Role": `${grp.staff.length} Staff`,
          "Contract Target": ""
        });
      }
      grp.staff.forEach(st => {
        const row = {
          "Staff Name": st.employeeName,
          "Role": st.designation,
          "Contract Target": `${st.contractHours}h`
        };
        calendarDays.forEach(d => {
          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
          row[`${d.dayName.substring(0,3)} ${formatShortDate(d.dateString)}`] = rec ? rec.status : "OFF";
        });
        row["Floor Shifts Worked"] = st.floorShiftsWorked;
        row["Floor Hours Worked"] = `${st.floorHoursWorked}h`;
        row["Fulfillment Status"] = st.contractStatus;
        rows.push(row);
      });
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Monthly Staff Matrix");
    XLSX.writeFile(wb, `CareHome_Staff_Monthly_Matrix_${safePeriod}.xlsx`);

  } else {
    const rows = balances.map(b => ({
      "Staff Name": b.employeeName,
      "Role": b.designation,
      "Contract Hours": `${b.contractHours}h`,
      "Shift Duration": `${b.shiftHours}h`,
      "Required Shifts": Math.ceil(b.netTargetHours / b.shiftHours),
      "Shifts Worked": b.floorShiftsWorked,
      "Floor Hours Worked": `${b.floorHoursWorked}h`,
      "Leave Days": b.leaveDays,
      "Leave Credit (hrs)": `${b.leaveDedHours}h`,
      "Total Accounted Hours": `${b.floorHoursWorked + b.leaveDedHours}h`,
      "Balance Remaining": `${b.balanceRemaining}h`,
      "Fulfillment Status": b.contractStatus
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Contract Balances");
    XLSX.writeFile(wb, `CareHome_Contract_Hours_Balances_${safePeriod}.xlsx`);
  }
}

/* ==========================================================
   LANDSCAPE PRINT SYSTEM (1 Week Per Sheet • Day & Night Separate)
   ========================================================= */

function preparePrintContainer() {
  const container = document.getElementById("printContainer");
  if (!container || !currentRotaData) return;

  const rota = currentRotaData.rota || [];
  const balances = currentRotaData.balances || [];
  const weeks = getRotaWeeks(currentRotaData);
  const periodLabel = currentRotaData.periodLabel || "Cycle";
  const dailyRequiredTotals = currentRotaData.dailyRequiredTotals || { day: 16, night: 10 };
  const staffList = [...balances].sort((a, b) => a.designation.localeCompare(b.designation) || a.employeeName.localeCompare(b.employeeName));

  let html = "";
  weeks.forEach(w => {
    const dayStaff = staffList.filter(st => {
      if (st.staffType === "D") return true;
      return w.days.some(d => {
        const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
        return rec && rec.shift === "D";
      });
    });

    const nightStaff = staffList.filter(st => {
      if (st.staffType === "N") return true;
      return w.days.some(d => {
        const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
        return rec && rec.shift === "N";
      });
    });

    // 1. DAY SHIFT PRINT SHEET
    html += `
      <div class="print-week-sheet">
        <div class="print-sheet-header">
          <div>
            <div class="print-sheet-title">CARE HOME ROTA &bull; WEEK ${w.num} DAY SHIFT SCHEDULE</div>
            <div class="print-sheet-period">Cycle Period: ${formatShortDate(w.days[0].dateString)} &ndash; ${formatShortDate(w.days[6].dateString)} (${periodLabel})</div>
          </div>
          <div style="font-size:9pt; font-weight:700; color:#0b3542; text-align:right;">
            DAY STAFF: ${dayStaff.length} &bull; DAY REQ: ${dailyRequiredTotals.day}/DAY
          </div>
        </div>

        <table class="print-table">
          <thead>
            <tr>
              <th class="th-left" style="width:26%;">Staff Name</th>
              <th class="th-left" style="width:16%;">Role</th>
              <th style="width:14%;">Contract Hours</th>
              ${w.days.map(d => `
                <th style="width:6.3%;">
                  ${d.dayName.substring(0,3)}<br>
                  <small>${formatShortDate(d.dateString)}</small>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${groupStaffByFloor(dayStaff, currentRotaData.rolePriorityMap).map(grp => {
              if (grp.staff.length === 0) return '';
              return `
                ${grp.showHeader ? `
                  <tr style="background:#e2e8f0; font-weight:800; font-size:9pt; color:#0f172a; border-top:1.5px solid #cbd5e1; border-bottom:1px solid #cbd5e1;">
                    <td colspan="${3 + w.days.length}" style="padding:4px 8px;">
                      ${grp.label} &bull; ${grp.staff.length} Active Staff
                    </td>
                  </tr>
                ` : ''}
                ${grp.staff.map(st => {
                  return `
                    <tr>
                      <td>
                        <strong>${esc(st.employeeName)}</strong>
                      </td>
                      <td>${esc(st.designation)}</td>
                      <td style="text-align:center; font-weight:600;">${st.contractHours}h</td>
                      ${w.days.map(d => {
                        const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                        const status = rec ? rec.status : "OFF";
                        return `<td style="text-align:center;"><span class="print-badge print-badge-${status}">${status}</span></td>`;
                      }).join('')}
                    </tr>
                  `;
                }).join('')}
              `;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="background:#f1f5f9; font-weight:700;">
              <td colspan="3" style="text-align:right; font-size:8.5pt; color:#475569;">Required Day Staff</td>
              ${w.days.map(() => `<td style="text-align:center; font-weight:800; font-size:9pt; color:#475569;">${dailyRequiredTotals.day}</td>`).join('')}
            </tr>
            <tr style="background:#e2e8f0; font-weight:800;">
              <td colspan="3" style="text-align:right; font-size:8.5pt; color:#0f172a;">Allotted Day Staff</td>
              ${w.days.map(d => {
                const count = rota.filter(r => r.date === d.dateString && r.shift === "D" && r.status !== "TR").length;
                return `<td style="text-align:center; font-weight:800; font-size:9pt; color:#0f172a;">${count}</td>`;
              }).join('')}
            </tr>
          </tfoot>
        </table>
      </div>
    `;

    // 2. NIGHT SHIFT PRINT SHEET
    html += `
      <div class="print-week-sheet">
        <div class="print-sheet-header">
          <div>
            <div class="print-sheet-title">CARE HOME ROTA &bull; WEEK ${w.num} NIGHT SHIFT SCHEDULE</div>
            <div class="print-sheet-period">Cycle Period: ${formatShortDate(w.days[0].dateString)} &ndash; ${formatShortDate(w.days[6].dateString)} (${periodLabel})</div>
          </div>
          <div style="font-size:9pt; font-weight:700; color:#1e1b4b; text-align:right;">
            NIGHT STAFF: ${nightStaff.length} &bull; NIGHT REQ: ${dailyRequiredTotals.night}/DAY
          </div>
        </div>

        <table class="print-table">
          <thead>
            <tr>
              <th class="th-left" style="width:26%;">Staff Name</th>
              <th class="th-left" style="width:16%;">Role</th>
              <th style="width:14%;">Contract Hours</th>
              ${w.days.map(d => `
                <th style="width:6.3%;">
                  ${d.dayName.substring(0,3)}<br>
                  <small>${formatShortDate(d.dateString)}</small>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody>
            ${sortStaffByPriority(nightStaff, currentRotaData.rolePriorityMap).map(st => {
              return `
                <tr>
                  <td><strong>${esc(st.employeeName)}</strong></td>
                  <td>${esc(st.designation)}</td>
                  <td style="text-align:center; font-weight:600;">${st.contractHours}h</td>
                  ${w.days.map(d => {
                    const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                    const status = rec ? rec.status : "OFF";
                    return `<td style="text-align:center;"><span class="print-badge print-badge-${status}">${status}</span></td>`;
                  }).join('')}
                </tr>
              `;
            }).join('')}
          </tbody>
          <tfoot>
            <tr style="background:#f1f5f9; font-weight:700;">
              <td colspan="3" style="text-align:right; font-size:8.5pt; color:#475569;">Required Night Staff</td>
              ${w.days.map(() => `<td style="text-align:center; font-weight:800; font-size:9pt; color:#475569;">${dailyRequiredTotals.night}</td>`).join('')}
            </tr>
            <tr style="background:#e2e8f0; font-weight:800;">
              <td colspan="3" style="text-align:right; font-size:8.5pt; color:#0f172a;">Allotted Night Staff</td>
              ${w.days.map(d => {
                const count = rota.filter(r => r.date === d.dateString && r.shift === "N").length;
                return `<td style="text-align:center; font-weight:800; font-size:9pt; color:#0f172a;">${count}</td>`;
              }).join('')}
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  });

  container.innerHTML = html;
}

function printRotaLandscape() {
  preparePrintContainer();
  setTimeout(() => {
    window.print();
  }, 100);
}

window.addEventListener("beforeprint", preparePrintContainer);

/* ==========================================================
   VIEW 2: STAFF MANAGEMENT (Backend ID Hidden, Custom Shift Hours & Slicers)
   ========================================================= */

let staffSearchQuery = "";
let staffFilterRole = "all";
let staffFilterFloor = "all";
let staffFilterShift = "all"; // 'all', 'D', 'N'
let cachedEmployeesList = [];

function updateStaffSearch(val) {
  staffSearchQuery = val;
  applyStaffFilters();
}

function updateStaffFloorFilter(val) {
  staffFilterFloor = val;
  applyStaffFilters();
}

function updateStaffRoleFilter(val) {
  staffFilterRole = val;
  applyStaffFilters();
}

function updateStaffShiftFilter(val) {
  staffFilterShift = val;
  document.querySelectorAll(".staff-shift-btn").forEach(btn => {
    if (btn.getAttribute("data-shift") === val) {
      btn.classList.remove("btn-secondary");
      btn.classList.add("btn-primary");
    } else {
      btn.classList.remove("btn-primary");
      btn.classList.add("btn-secondary");
    }
  });
  applyStaffFilters();
}

function resetStaffFilters() {
  staffSearchQuery = "";
  staffFilterRole = "all";
  staffFilterFloor = "all";
  staffFilterShift = "all";
  renderEmployeesView();
}

function applyStaffFilters() {
  const tbody = document.getElementById("staffTableBody");
  const countEl = document.getElementById("staffCountBadge");
  if (!tbody || !cachedEmployeesList) return;

  const filtered = cachedEmployeesList.filter(emp => {
    if (staffFilterShift === "D" && emp.staff_type !== "D") return false;
    if (staffFilterShift === "N" && emp.staff_type !== "N") return false;
    if (staffFilterRole !== "all" && emp.designation !== staffFilterRole) return false;
    if (staffFilterFloor !== "all" && (emp.floor || "").trim() !== staffFilterFloor) return false;
    if (staffSearchQuery.trim()) {
      const q = staffSearchQuery.trim().toLowerCase();
      const matchName = (emp.name || "").toLowerCase().includes(q);
      const matchRole = (emp.designation || "").toLowerCase().includes(q);
      if (!matchName && !matchRole) return false;
    }
    return true;
  });

  if (countEl) {
    countEl.innerHTML = `Showing <strong>${filtered.length}</strong> of ${cachedEmployeesList.length} staff members (System automatically manages backend ID)`;
  }

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align:center; padding:36px; color:#64748b; font-style:italic;">
          No staff members match the selected filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtered.map(emp => `
    <tr>
      <td><strong>${esc(emp.name)}</strong></td>
      <td>${esc(emp.designation)}</td>
      <td>
        ${emp.floor ? `<span style="background:#f1f5f9; color:#0f172a; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px;">🏢 ${esc(emp.floor)}</span>` : '<span style="color:#94a3b8; font-size:12px;">—</span>'}
      </td>
      <td>${emp.contract_hours} hrs/wk</td>
      <td style="font-weight:700; color:#0284c7;">${emp.shift_hours || 11} hrs/shift</td>
      <td>
        <span class="status-pill status-${emp.staff_type}">
          ${emp.staff_type === 'N' ? '🌙 Night' : '☀️ Day'}
        </span>
      </td>
      <td>
        <span style="color:${emp.active ? '#15803d' : '#94a3b8'}; font-weight:700;">
          ${emp.active ? '● Active' : '○ Inactive'}
        </span>
      </td>
      <td style="text-align:right;">
        <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick='openEmployeeModal(${JSON.stringify(emp).replace(/'/g, "&apos;")})'>
          Edit
        </button>
        <button class="btn btn-danger" style="padding:4px 10px; font-size:12px; margin-left:6px;" onclick="deleteEmployee('${emp.id}')">
          Delete
        </button>
      </td>
    </tr>
  `).join('');
}

async function renderEmployeesView() {
  const container = document.getElementById("viewContainer");
  try {
    cachedEmployeesList = await apiFetch("/api/employees");
    const employees = cachedEmployeesList;

    // Distinct roles and floors
    const allRoles = [...new Set(employees.map(e => e.designation))].sort();
    const allFloors = [...new Set(employees.map(e => (e.floor || "").trim()).filter(Boolean))].sort();

    // Initial filter
    const filtered = employees.filter(emp => {
      if (staffFilterShift === "D" && emp.staff_type !== "D") return false;
      if (staffFilterShift === "N" && emp.staff_type !== "N") return false;
      if (staffFilterRole !== "all" && emp.designation !== staffFilterRole) return false;
      if (staffFilterFloor !== "all" && (emp.floor || "").trim() !== staffFilterFloor) return false;
      if (staffSearchQuery.trim()) {
        const q = staffSearchQuery.trim().toLowerCase();
        const matchName = (emp.name || "").toLowerCase().includes(q);
        const matchRole = (emp.designation || "").toLowerCase().includes(q);
        if (!matchName && !matchRole) return false;
      }
      return true;
    });

    container.innerHTML = `
      <div class="card">
        <div class="card-header" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div>
            <div class="card-title">Staff Members Registry</div>
            <div id="staffCountBadge" style="font-size:13px; color:#64748b;">
              Showing <strong>${filtered.length}</strong> of ${employees.length} staff members (System automatically manages backend ID)
            </div>
          </div>
          <button class="btn btn-primary" onclick="openEmployeeModal()">
            + Add Staff Member
          </button>
        </div>

        <!-- Slicers & Filter Bar (Role, Floor, Shift Type, Staff Search) -->
        <div style="background:#f8fafc; border-top:1px solid #e2e8f0; border-bottom:1px solid #e2e8f0; padding:12px 18px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <!-- Search Bar -->
            <div style="position:relative; min-width:200px;">
              <input type="text" id="staffSearchInput" class="form-control" placeholder="🔍 Search staff by name..." value="${esc(staffSearchQuery)}" oninput="updateStaffSearch(this.value)" style="padding:6px 12px; font-size:12.5px;">
            </div>

            <!-- Floor Slicer -->
            <select class="form-control" onchange="updateStaffFloorFilter(this.value)" style="width:auto; padding:6px 10px; font-size:12.5px; font-weight:600;">
              <option value="all" ${staffFilterFloor === 'all' ? 'selected' : ''}>🏢 All Floors (${allFloors.length})</option>
              ${allFloors.map(f => `<option value="${esc(f)}" ${staffFilterFloor === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}
            </select>

            <!-- Role Slicer -->
            <select class="form-control" onchange="updateStaffRoleFilter(this.value)" style="width:auto; padding:6px 10px; font-size:12.5px; font-weight:600;">
              <option value="all" ${staffFilterRole === 'all' ? 'selected' : ''}>👔 All Roles (${allRoles.length})</option>
              ${allRoles.map(r => `<option value="${esc(r)}" ${staffFilterRole === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}
            </select>

            <!-- Shift Type Slicer -->
            <div style="display:inline-flex; gap:4px; align-items:center;">
              <span style="font-size:11px; font-weight:800; color:#64748b; text-transform:uppercase; margin-right:2px;">Shift:</span>
              <button type="button" class="btn staff-shift-btn ${staffFilterShift === 'all' ? 'btn-primary' : 'btn-secondary'}" data-shift="all" style="padding:4px 10px; font-size:12px;" onclick="updateStaffShiftFilter('all')">
                All
              </button>
              <button type="button" class="btn staff-shift-btn ${staffFilterShift === 'D' ? 'btn-primary' : 'btn-secondary'}" data-shift="D" style="padding:4px 10px; font-size:12px;" onclick="updateStaffShiftFilter('D')">
                ☀️ Day
              </button>
              <button type="button" class="btn staff-shift-btn ${staffFilterShift === 'N' ? 'btn-primary' : 'btn-secondary'}" data-shift="N" style="padding:4px 10px; font-size:12px;" onclick="updateStaffShiftFilter('N')">
                🌙 Night
              </button>
            </div>
          </div>

          ${(staffSearchQuery || staffFilterRole !== 'all' || staffFilterFloor !== 'all' || staffFilterShift !== 'all') ? `
            <button class="btn btn-secondary" onclick="resetStaffFilters()" style="padding:5px 10px; font-size:12px; color:#dc2626; border-color:#fca5a5;">
              ✕ Reset Filters
            </button>
          ` : ''}
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Staff Name</th>
                <th>Role / Designation</th>
                <th style="background:#f8fafc; color:#0f172a;">Floor</th>
                <th>Weekly Contract</th>
                <th style="background:#e0f2fe; color:#0369a1;">Shift Duration</th>
                <th>Shift Type</th>
                <th>Status</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody id="staffTableBody">
              ${filtered.length === 0 ? `
                <tr>
                  <td colspan="8" style="text-align:center; padding:36px; color:#64748b; font-style:italic;">
                    No staff members match the selected filters.
                  </td>
                </tr>
              ` : filtered.map(emp => `
                <tr>
                  <td><strong>${esc(emp.name)}</strong></td>
                  <td>${esc(emp.designation)}</td>
                  <td>
                    ${emp.floor ? `<span style="background:#f1f5f9; color:#0f172a; padding:2px 8px; border-radius:4px; font-weight:600; font-size:12px;">🏢 ${esc(emp.floor)}</span>` : '<span style="color:#94a3b8; font-size:12px;">—</span>'}
                  </td>
                  <td>${emp.contract_hours} hrs/wk</td>
                  <td style="font-weight:700; color:#0284c7;">${emp.shift_hours || 11} hrs/shift</td>
                  <td>
                    <span class="status-pill status-${emp.staff_type}">
                      ${emp.staff_type === 'N' ? '🌙 Night' : '☀️ Day'}
                    </span>
                  </td>
                  <td>
                    <span style="color:${emp.active ? '#15803d' : '#94a3b8'}; font-weight:700;">
                      ${emp.active ? '● Active' : '○ Inactive'}
                    </span>
                  </td>
                  <td style="text-align:right;">
                    <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick='openEmployeeModal(${JSON.stringify(emp).replace(/'/g, "&apos;")})'>
                      Edit
                    </button>
                    <button class="btn btn-danger" style="padding:4px 10px; font-size:12px; margin-left:6px;" onclick="deleteEmployee('${emp.id}')">
                      Delete
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

async function openEmployeeModal(emp = null) {
  const isEdit = !!emp;
  let roles = ['Carer', 'Senior Carer', 'Staff Nurse', 'Team Leader', 'Advanced Team Leader', 'Clinical Lead', 'Dy. Manager', 'Wellbeing Staff', 'Hostes', 'Maintance Staff', 'Physiotherapist'];
  try {
    const [hList, rList] = await Promise.all([
      apiFetch("/api/hierarchy").catch(() => []),
      apiFetch("/api/requirements").catch(() => [])
    ]);
    const roleSet = new Set(roles);
    (hList || []).forEach(h => { if (h.required_role) roleSet.add(h.required_role.trim()); });
    (rList || []).forEach(r => { if (r.role_name) roleSet.add(r.role_name.trim()); });
    if (emp && emp.designation) roleSet.add(emp.designation.trim());
    roles = Array.from(roleSet).sort((a, b) => a.localeCompare(b));
  } catch (e) {
    // fallback to default list
  }

  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>${isEdit ? 'Edit Staff Member' : 'Add New Staff Member'}</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveEmployee(event, '${emp ? emp.id : ''}')">
          <div class="modal-body">
            <div class="form-group">
              <label>Full Name</label>
              <input type="text" id="empName" class="form-control" required value="${emp ? esc(emp.name) : ''}">
            </div>

            <div class="form-group">
              <label>Role / Designation</label>
              <select id="empDesig" class="form-control" required>
                ${roles.map(r => `
                  <option value="${esc(r)}" ${emp && emp.designation === r ? 'selected' : ''}>${esc(r)}</option>
                `).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Assigned Floor</label>
              <select id="empFloor" class="form-control">
                <option value="" ${!emp || !emp.floor ? 'selected' : ''}>-- No Floor / Unassigned --</option>
                <option value="Top Floor" ${emp && emp.floor === 'Top Floor' ? 'selected' : ''}>🏢 Top Floor</option>
                <option value="Ground Floor" ${emp && emp.floor === 'Ground Floor' ? 'selected' : ''}>🏢 Ground Floor</option>
                <option value="Lower Ground Floor" ${emp && emp.floor === 'Lower Ground Floor' ? 'selected' : ''}>🏢 Lower Ground Floor</option>
              </select>
              <small style="color:#64748b; font-size:11px;">Primary floor assignment (leave blank for night staff or unassigned)</small>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
              <div class="form-group">
                <label>Weekly Contract Hours</label>
                <input type="number" step="any" id="empContract" class="form-control" required value="${emp ? emp.contract_hours : '44'}">
              </div>

              <div class="form-group">
                <label>Shift Duration (Hours)</label>
                <input type="number" step="any" id="empShiftHours" class="form-control" required value="${emp ? (emp.shift_hours || 11) : '11'}">
                <small style="color:#64748b; font-size:11px;">Arbitrary decimal values allowed (e.g. 11, 7.5, 8.25)</small>
              </div>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
              <div class="form-group">
                <label>Primary Shift Type</label>
                <select id="empShiftType" class="form-control">
                  <option value="D" ${emp && emp.staff_type === 'D' ? 'selected' : ''}>☀️ Day Shift</option>
                  <option value="N" ${emp && emp.staff_type === 'N' ? 'selected' : ''}>🌙 Night Shift</option>
                </select>
              </div>

              <div class="form-group">
                <label>Active Status</label>
                <select id="empActive" class="form-control">
                  <option value="1" ${!emp || emp.active ? 'selected' : ''}>Active</option>
                  <option value="0" ${emp && !emp.active ? 'selected' : ''}>Inactive</option>
                </select>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Staff Member'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveEmployee(e, empId) {
  e.preventDefault();
  const name = document.getElementById("empName").value;
  const designation = document.getElementById("empDesig").value;
  const floor = document.getElementById("empFloor").value.trim();
  const contract_hours = parseFloat(document.getElementById("empContract").value) || 44;
  const shift_hours = parseFloat(document.getElementById("empShiftHours").value) || 11;
  const staff_type = document.getElementById("empShiftType").value;
  const active = parseInt(document.getElementById("empActive").value, 10);

  try {
    if (empId) {
      await apiFetch(`/api/employees/${empId}`, {
        method: "PUT",
        body: JSON.stringify({ name, designation, floor, contract_hours, shift_hours, staff_type, active })
      });
    } else {
      await apiFetch("/api/employees", {
        method: "POST",
        body: JSON.stringify({ name, designation, floor, contract_hours, shift_hours, staff_type, active })
      });
    }
    closeModal();
    renderEmployeesView();
  } catch (err) {
    alert("Error saving: " + err.message);
  }
}

async function deleteEmployee(id) {
  showConfirmModal({
    title: "Delete Staff Member",
    message: "Are you sure you want to remove this staff member from the system? This action cannot be undone.",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/employees/${id}`, { method: "DELETE" });
        renderEmployeesView();
      } catch (err) {
        alert("Error deleting employee: " + err.message);
      }
    }
  });
}

/* ==========================================================
   VIEW 3: STAFF REQUIREMENTS (Daily Quotas)
   ========================================================= */

async function renderRequirementsView() {
  const container = document.getElementById("viewContainer");
  try {
    const reqs = await apiFetch("/api/requirements");
    const totalDay = reqs.reduce((a, b) => a + (b.day_required || 0), 0);
    const totalNight = reqs.reduce((a, b) => a + (b.night_required || 0), 0);

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Daily Staffing Quotas</div>
            <div style="font-size:13px; color:#64748b;">
              Total Daily Demand: <strong>${totalDay} Day</strong> &nbsp;•&nbsp; <strong>${totalNight} Night</strong>
            </div>
          </div>
          <button class="btn btn-primary" onclick="openRequirementModal()">
            + Add Role Quota
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Role / Designation</th>
                <th style="text-align:center;">☀️ Day Required</th>
                <th style="text-align:center;">🌙 Night Required</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${reqs.map(r => `
                <tr>
                  <td><strong>${esc(r.role_name)}</strong></td>
                  <td style="text-align:center; font-weight:700; color:#0f172a; font-size:15px;">${r.day_required}</td>
                  <td style="text-align:center; font-weight:700; color:#1e1b4b; font-size:15px;">${r.night_required}</td>
                  <td style="text-align:right;">
                    <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px;" onclick='openRequirementModal(${JSON.stringify(r)})'>
                      Edit Quota
                    </button>
                    <button class="btn btn-danger" style="padding:4px 10px; font-size:12px; margin-left:6px;" onclick="deleteRequirement(${r.id})">
                      Delete
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

function openRequirementModal(req = null) {
  const isEdit = !!req;
  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>${isEdit ? 'Edit Role Quota' : 'Add Role Quota'}</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveRequirement(event, ${req ? req.id : 'null'})">
          <div class="modal-body">
            <div class="form-group">
              <label>Role Name</label>
              <input type="text" id="reqRoleName" class="form-control" required value="${req ? esc(req.role_name) : ''}" ${isEdit ? 'readonly' : ''}>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
              <div class="form-group">
                <label>Day Staff Required</label>
                <input type="number" id="reqDay" class="form-control" required value="${req ? req.day_required : '1'}">
              </div>
              <div class="form-group">
                <label>Night Staff Required</label>
                <input type="number" id="reqNight" class="form-control" required value="${req ? req.night_required : '0'}">
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Quota</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveRequirement(e, id) {
  e.preventDefault();
  const role_name = document.getElementById("reqRoleName").value;
  const day_required = parseInt(document.getElementById("reqDay").value, 10);
  const night_required = parseInt(document.getElementById("reqNight").value, 10);

  try {
    if (id) {
      await apiFetch(`/api/requirements/${id}`, {
        method: "PUT",
        body: JSON.stringify({ day_required, night_required })
      });
    } else {
      await apiFetch("/api/requirements", {
        method: "POST",
        body: JSON.stringify({ role_name, day_required, night_required })
      });
    }
    closeModal();
    renderRequirementsView();
  } catch (err) {
    alert("Error saving quota: " + err.message);
  }
}

async function deleteRequirement(id) {
  showConfirmModal({
    title: "Delete Role Quota",
    message: "Are you sure you want to delete this staffing quota?",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/requirements/${id}`, { method: "DELETE" });
        renderRequirementsView();
      } catch (err) {
        alert("Error deleting quota: " + err.message);
      }
    }
  });
}

/* ==========================================================
   VIEW 4: ROLE HIERARCHY & SUBSTITUTIONS
   ========================================================= */

async function renderHierarchyView() {
  const container = document.getElementById("viewContainer");
  try {
    const list = await apiFetch("/api/hierarchy");

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Role Hierarchy & Shift Substitutions</div>
            <div style="font-size:13px; color:#64748b;">
              Roles are filled in Priority (1, 2, 3...) order. If primary staff are unavailable, the engine evaluates substitutes left-to-right.
            </div>
          </div>
          <button class="btn btn-primary" onclick="openHierarchyModal()">
            + Add Hierarchy Rule
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width:70px; text-align:center;">Priority</th>
                <th>Required Role</th>
                <th style="width:105px; text-align:center;">Days / Wk</th>
                <th style="background:#e6f6ec; color:#15803d;">Substitute 1</th>
                <th>Substitute 2</th>
                <th>Substitute 3</th>
                <th>Substitute 4</th>
                <th style="text-align:right; width:150px;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(h => `
                <tr>
                  <td style="text-align:center; font-weight:800; font-size:14px; color:#0b3542;">${h.priority}</td>
                  <td><strong>${esc(h.required_role)}</strong></td>
                  <td style="text-align:center;">
                    <span class="badge" style="background:#e0f2fe; color:#0369a1; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:700;">
                      ${h.days_per_week !== undefined && h.days_per_week !== null ? h.days_per_week : 7} d/wk
                    </span>
                  </td>
                  <td style="font-weight:600; color:#15803d;">${esc(h.substitute_1 || '—')}</td>
                  <td>${esc(h.substitute_2 || '—')}</td>
                  <td>${esc(h.substitute_3 || '—')}</td>
                  <td>${esc(h.substitute_4 || '—')}</td>
                  <td style="text-align:right; white-space:nowrap;">
                    <button class="btn btn-secondary" style="padding:4px 10px; font-size:12px; margin-right:6px;" onclick='openHierarchyModal(${JSON.stringify(h).replace(/'/g, "&apos;")})'>
                      ✏️ Edit
                    </button>
                    <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deleteHierarchy(${h.id})">
                      Delete
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

function openHierarchyModal(h = null) {
  const isEdit = !!h;
  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>${isEdit ? 'Edit Role Hierarchy Rule' : 'Add Role Hierarchy Rule'}</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveHierarchy(event, ${h ? h.id : 'null'})">
          <div class="modal-body">
            <div style="display:grid; grid-template-columns:100px 1fr 130px; gap:16px;">
              <div class="form-group">
                <label>Priority</label>
                <input type="number" id="hierPri" class="form-control" required value="${h ? h.priority : 1}" min="1">
              </div>
              <div class="form-group">
                <label>Required Role</label>
                <input type="text" id="hierReq" class="form-control" required placeholder="e.g. Staff Nurse" value="${h ? esc(h.required_role) : ''}">
              </div>
              <div class="form-group">
                <label>Days / Wk Required</label>
                <input type="number" id="hierDays" class="form-control" required min="1" max="7" value="${h && h.days_per_week !== undefined && h.days_per_week !== null ? h.days_per_week : 7}">
              </div>
            </div>

            <div class="form-group">
              <label>Substitute 1 (Primary Backup)</label>
              <input type="text" id="hierSub1" class="form-control" placeholder="e.g. Team Leader" value="${h ? esc(h.substitute_1 || '') : ''}">
            </div>
            <div class="form-group">
              <label>Substitute 2</label>
              <input type="text" id="hierSub2" class="form-control" placeholder="e.g. Senior Carer" value="${h ? esc(h.substitute_2 || '') : ''}">
            </div>
            <div class="form-group">
              <label>Substitute 3</label>
              <input type="text" id="hierSub3" class="form-control" placeholder="e.g. Carer" value="${h ? esc(h.substitute_3 || '') : ''}">
            </div>
            <div class="form-group">
              <label>Substitute 4</label>
              <input type="text" id="hierSub4" class="form-control" placeholder="e.g. Clinical Lead" value="${h ? esc(h.substitute_4 || '') : ''}">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Save Rule'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveHierarchy(e, id = null) {
  e.preventDefault();
  const priority = parseInt(document.getElementById("hierPri").value, 10) || 99;
  const required_role = document.getElementById("hierReq").value.trim();
  const days_per_week = parseInt(document.getElementById("hierDays").value, 10) || 7;
  const substitute_1 = document.getElementById("hierSub1").value.trim();
  const substitute_2 = document.getElementById("hierSub2").value.trim();
  const substitute_3 = document.getElementById("hierSub3").value.trim();
  const substitute_4 = document.getElementById("hierSub4").value.trim();

  try {
    if (id) {
      await apiFetch(`/api/hierarchy/${id}`, {
        method: "PUT",
        body: JSON.stringify({ priority, required_role, days_per_week, substitute_1, substitute_2, substitute_3, substitute_4 })
      });
    } else {
      await apiFetch("/api/hierarchy", {
        method: "POST",
        body: JSON.stringify({ priority, required_role, days_per_week, substitute_1, substitute_2, substitute_3, substitute_4 })
      });
    }
    closeModal();
    renderHierarchyView();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteHierarchy(id) {
  showConfirmModal({
    title: "Delete Hierarchy Rule",
    message: "Are you sure you want to delete this role hierarchy rule? This will remove this role substitution.",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/hierarchy/${id}`, { method: "DELETE" });
        renderHierarchyView();
      } catch (err) {
        alert("Error deleting hierarchy rule: " + err.message);
      }
    }
  });
}

/* ==========================================================
   VIEW 5: APPROVED LEAVE
   ========================================================= */

async function renderLeaveView() {
  const container = document.getElementById("viewContainer");
  try {
    const list = await apiFetch("/api/leave");

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Approved Leave Records</div>
            <div style="font-size:13px; color:#64748b;">
              Approved leave automatically deducts hours from the employee's weekly contract target.
            </div>
          </div>
          <button class="btn btn-primary" onclick="openLeaveModal()">
            + Book Approved Leave
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Staff Name</th>
                <th>Designation</th>
                <th>Leave Type</th>
                <th>From Date</th>
                <th>To Date</th>
                <th>Status</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.length === 0 ? `<tr><td colspan="7" style="text-align:center; padding:30px; color:#64748b;">No leave records found.</td></tr>` : list.map(l => `
                <tr>
                  <td><strong>${esc(l.employee_name)}</strong></td>
                  <td>${esc(l.designation)}</td>
                  <td>${esc(l.leave_type)}</td>
                  <td>${l.start_date}</td>
                  <td>${l.end_date}</td>
                  <td><span class="status-pill status-L">${l.status}</span></td>
                  <td style="text-align:right;">
                    <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deleteLeave(${l.id})">
                      Cancel Leave
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

async function openLeaveModal() {
  const employees = await apiFetch("/api/employees");
  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Book Approved Leave</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveLeave(event)">
          <div class="modal-body">
            <div class="form-group">
              <label>Staff Member</label>
              <select id="leaveEmpId" class="form-control" required>
                ${employees.map(e => `<option value="${e.id}">${esc(e.name)} (${esc(e.designation)})</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Leave Type</label>
              <select id="leaveType" class="form-control">
                <option value="Annual Leave">Annual Leave</option>
                <option value="Sick Leave">Sick Leave</option>
                <option value="Compassionate">Compassionate</option>
              </select>
            </div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
              <div class="form-group">
                <label>Start Date</label>
                <input type="date" id="leaveStart" class="form-control" required value="2026-10-05">
              </div>
              <div class="form-group">
                <label>End Date</label>
                <input type="date" id="leaveEnd" class="form-control" required value="2026-10-09">
              </div>
            </div>
            <div class="form-group">
              <label>Notes / Reason</label>
              <input type="text" id="leaveNotes" class="form-control" placeholder="Optional notes">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Book Leave</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveLeave(e) {
  e.preventDefault();
  const employee_id = document.getElementById("leaveEmpId").value;
  const leave_type = document.getElementById("leaveType").value;
  const start_date = document.getElementById("leaveStart").value;
  const end_date = document.getElementById("leaveEnd").value;
  const notes = document.getElementById("leaveNotes").value;

  try {
    await apiFetch("/api/leave", {
      method: "POST",
      body: JSON.stringify({ employee_id, leave_type, start_date, end_date, notes })
    });
    closeModal();
    renderLeaveView();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteLeave(id) {
  showConfirmModal({
    title: "Cancel Approved Leave",
    message: "Are you sure you want to cancel and delete this approved leave booking?",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/leave/${id}`, { method: "DELETE" });
        renderLeaveView();
      } catch (err) {
        alert("Error deleting leave record: " + err.message);
      }
    }
  });
}

/* ==========================================================
   VIEW 6: STAFF PREFERENCES & REPEATING PATTERNS
   ========================================================= */

async function renderPreferencesView() {
  const container = document.getElementById("viewContainer");
  try {
    const list = await apiFetch("/api/preferences");

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Staff Preferences & Repeating Shift Patterns</div>
            <div style="font-size:13px; color:#64748b;">
              Supports Specific Dates, Recurring Weekdays, and Custom Repeating Patterns (e.g. 4 Days Work / 2 Days Off).
            </div>
          </div>
          <button class="btn btn-primary" onclick="openPreferenceModal()">
            + Add Preference / Pattern
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Staff Name</th>
                <th>Role</th>
                <th>Preference Type</th>
                <th>Schedule Details</th>
                <th>Preference</th>
                <th>Remarks</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.length === 0 ? `<tr><td colspan="7" style="text-align:center; padding:30px; color:#64748b;">No preferences or patterns registered.</td></tr>` : list.map(p => {
                let detail = "";
                let typeBadge = "";
                if (p.type === "pattern") {
                  typeBadge = `<span style="background:#e0e7ff; color:#3730a3; padding:2px 8px; border-radius:4px; font-weight:700;">🔁 Pattern</span>`;
                  detail = `<strong>${p.pattern_work_days} Days ON / ${p.pattern_off_days} Days OFF</strong> (Anchor: ${p.pattern_start_date || 'N/A'})`;
                } else if (p.type === "day") {
                  typeBadge = `<span style="background:#fef3c7; color:#92400e; padding:2px 8px; border-radius:4px; font-weight:700;">🔄 Weekly Day</span>`;
                  detail = `Every <strong>${p.target_day}</strong>`;
                } else {
                  typeBadge = `<span style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-weight:700;">📅 Specific Date</span>`;
                  detail = `Date: <strong>${p.target_date}</strong>`;
                }

                return `
                  <tr>
                    <td><strong>${esc(p.employee_name)}</strong></td>
                    <td>${esc(p.designation)}</td>
                    <td>${typeBadge}</td>
                    <td>${detail}</td>
                    <td>
                      <span class="status-pill ${p.preference === 'prefer' ? 'status-D' : 'status-L'}">
                        ${p.preference === 'prefer' ? 'Prefer Work' : 'Unavailable / OFF'}
                      </span>
                    </td>
                    <td>${esc(p.remarks || '—')}</td>
                    <td style="text-align:right;">
                      <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deletePreference(${p.id})">
                        Delete
                      </button>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

// Multi-date selection state for preferences
window.prefSelectedDates = [];

function renderPrefDateChips() {
  const container = document.getElementById("selectedDatesChips");
  const countEl = document.getElementById("selectedDateCount");
  if (!container) return;

  if (countEl) {
    countEl.textContent = `${window.prefSelectedDates.length} selected`;
  }

  // Update cycle grid buttons selected class
  document.querySelectorAll(".period-date-btn").forEach(btn => {
    const d = btn.getAttribute("data-date");
    if (window.prefSelectedDates.includes(d)) {
      btn.classList.add("selected");
    } else {
      btn.classList.remove("selected");
    }
  });

  if (window.prefSelectedDates.length === 0) {
    container.innerHTML = `<span style="color:#94a3b8; font-size:12px; padding:4px;">No dates selected yet. Pick a date above or click dates below.</span>`;
    return;
  }

  container.innerHTML = [...window.prefSelectedDates].sort().map(d => `
    <span class="date-tag">
      ${d}
      <span class="date-tag-remove" onclick="removePrefDate('${d}')" title="Remove date">✕</span>
    </span>
  `).join('');
}

function addSelectedDateFromInput() {
  const dateInput = document.getElementById("prefDate");
  if (!dateInput || !dateInput.value) return;
  const val = dateInput.value;
  if (!window.prefSelectedDates.includes(val)) {
    window.prefSelectedDates.push(val);
    renderPrefDateChips();
  }
}

function toggleCycleDate(dateStr) {
  if (window.prefSelectedDates.includes(dateStr)) {
    window.prefSelectedDates = window.prefSelectedDates.filter(d => d !== dateStr);
  } else {
    window.prefSelectedDates.push(dateStr);
  }
  renderPrefDateChips();
}

function removePrefDate(dateStr) {
  window.prefSelectedDates = window.prefSelectedDates.filter(d => d !== dateStr);
  renderPrefDateChips();
}

function clearAllSelectedDates() {
  window.prefSelectedDates = [];
  renderPrefDateChips();
}

async function openPreferenceModal() {
  window.prefSelectedDates = [];
  const employees = await apiFetch("/api/employees");

  // Determine active 28-day cycle dates for quick multi-select buttons
  let cycleDays = [];
  if (currentRotaData && currentRotaData.calendarDays && currentRotaData.calendarDays.length === 28) {
    cycleDays = currentRotaData.calendarDays;
  } else {
    cycleDays = Array.from({ length: 28 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 28 + i));
      const dateString = d.toISOString().split("T")[0];
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      return { dateString, dayName: dayNames[d.getUTCDay()] };
    });
  }

  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Add Staff Preference / Pattern</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="savePreference(event)">
          <div class="modal-body">
            <div class="form-group">
              <label>Staff Member</label>
              <select id="prefEmpId" class="form-control" required>
                ${employees.map(e => `<option value="${e.id}">${esc(e.name)} (${esc(e.designation)})</option>`).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Category</label>
              <select id="prefType" class="form-control" onchange="togglePrefInputs()">
                <option value="date" selected>📅 Specific Date(s) (Multi-Select Supported)</option>
                <option value="pattern">🔁 Repeating Pattern (e.g. 4 on / 2 off)</option>
                <option value="day">🔄 Recurring Weekday</option>
              </select>
            </div>

            <!-- PATTERN INPUTS -->
            <div id="patternSection" style="display:none; background:#f8fafc; padding:14px; border-radius:6px; margin-bottom:16px; border:1px solid #e2e8f0;">
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:8px;">
                <div>
                  <label style="font-size:12px; font-weight:700;">Working Days in Block</label>
                  <input type="number" id="patternWork" class="form-control" value="4" min="1" max="14">
                </div>
                <div>
                  <label style="font-size:12px; font-weight:700;">Rest Days in Block</label>
                  <input type="number" id="patternOff" class="form-control" value="2" min="1" max="14">
                </div>
              </div>
              <div style="font-size:12px; color:#475569; margin-top:6px; line-height:1.4;">
                ℹ️ Repeating pattern automatically aligns with the active rota period start date.
              </div>
            </div>

            <!-- SPECIFIC DATE(S) MULTI-DATE INPUT -->
            <div id="dateSection" class="form-group">
              <label style="display:flex; justify-content:space-between; align-items:center;">
                <span>Select Target Date(s)</span>
                <span id="selectedDateCount" style="font-size:12px; color:#0e4b5d; font-weight:700;">0 selected</span>
              </label>

              <div style="display:flex; gap:8px; margin-bottom:10px;">
                <input type="date" id="prefDate" class="form-control" value="2026-10-15" style="flex:1;">
                <button type="button" class="btn btn-secondary" onclick="addSelectedDateFromInput()" style="white-space:nowrap; padding:8px 12px; font-size:13px;">
                  + Add Date
                </button>
              </div>

              <div style="margin-bottom:12px;">
                <div style="font-size:12px; font-weight:600; color:#475569; margin-bottom:4px; display:flex; justify-content:space-between; align-items:center;">
                  <span>Selected Dates:</span>
                  <button type="button" onclick="clearAllSelectedDates()" style="background:none; border:none; color:#dc2626; font-size:11px; cursor:pointer; text-decoration:underline;">Clear all</button>
                </div>
                <div id="selectedDatesChips" class="date-chip-grid" style="min-height:46px;">
                  <span style="color:#94a3b8; font-size:12px; padding:4px;">No dates selected yet. Pick a date above or click below.</span>
                </div>
              </div>

              <!-- Quick Selection Grid from 28-day active cycle -->
              <div style="background:#f1f5f9; padding:10px 12px; border-radius:6px; border:1px solid #cbd5e1;">
                <div style="font-size:11px; font-weight:700; color:#334155; text-transform:uppercase; margin-bottom:6px;">
                  Quick Pick from 28-Day Period (Click to toggle dates)
                </div>
                <div id="cycleDatesGrid" style="display:grid; grid-template-columns:repeat(7, 1fr); gap:4px;">
                  ${cycleDays.map(d => `
                    <button type="button" class="period-date-btn" data-date="${d.dateString}" onclick="toggleCycleDate('${d.dateString}')">
                      ${d.dayName.substring(0,1)} ${d.dateString.substring(8)}
                    </button>
                  `).join('')}
                </div>
              </div>
            </div>

            <!-- RECURRING DAY(S) MULTI-DAY INPUT -->
            <div id="daySection" style="display:none;" class="form-group">
              <label style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <span>Recurring Day(s) of Week</span>
                <span id="selectedDaysSummary" style="font-size:12px; color:#0e4b5d; font-weight:700;">1 selected</span>
              </label>
              <div style="display:flex; flex-wrap:wrap; gap:8px;">
                ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((day, idx) => `
                  <label style="cursor:pointer; display:inline-flex; align-items:center; gap:6px; background:#f1f5f9; padding:6px 12px; border-radius:20px; border:1px solid #cbd5e1; font-size:13px; font-weight:600; user-select:none;">
                    <input type="checkbox" name="prefDays" value="${day}" ${idx === 0 ? 'checked' : ''} onchange="updateSelectedDaysSummary()" style="accent-color:#0e4b5d;">
                    ${day}
                  </label>
                `).join('')}
              </div>
            </div>

            <div class="form-group">
              <label>Preference Intent</label>
              <select id="prefIntent" class="form-control">
                <option value="prefer">Prefer to Work</option>
                <option value="unavailable">Unavailable / Request OFF</option>
              </select>
            </div>

            <div class="form-group">
              <label>Remarks</label>
              <input type="text" id="prefRemarks" class="form-control" placeholder="e.g. Specific requested days off">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Preference</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
  renderPrefDateChips();
}

function updateSelectedDaysSummary() {
  const checked = Array.from(document.querySelectorAll("input[name='prefDays']:checked")).map(cb => cb.value);
  const sumEl = document.getElementById("selectedDaysSummary");
  if (sumEl) {
    sumEl.textContent = `${checked.length} selected`;
  }
}

function togglePrefInputs() {
  const type = document.getElementById("prefType").value;
  document.getElementById("patternSection").style.display = type === "pattern" ? "block" : "none";
  document.getElementById("dateSection").style.display = type === "date" ? "block" : "none";
  document.getElementById("daySection").style.display = type === "day" ? "block" : "none";
}

async function savePreference(e) {
  e.preventDefault();
  const employee_id = document.getElementById("prefEmpId").value;
  const type = document.getElementById("prefType").value;
  const pattern_work_days = document.getElementById("patternWork") ? document.getElementById("patternWork").value : null;
  const pattern_off_days = document.getElementById("patternOff") ? document.getElementById("patternOff").value : null;
  const preference = document.getElementById("prefIntent").value;
  const remarks = document.getElementById("prefRemarks").value;

  let target_dates = [];
  if (type === "date") {
    target_dates = [...window.prefSelectedDates];
    const dateInputVal = document.getElementById("prefDate").value;
    if (target_dates.length === 0 && dateInputVal) {
      target_dates.push(dateInputVal);
    }
    if (target_dates.length === 0) {
      alert("Please select at least one date for this preference.");
      return;
    }
  }

  let selectedDays = [];
  let target_day = null;
  if (type === "day") {
    selectedDays = Array.from(document.querySelectorAll("input[name='prefDays']:checked")).map(cb => cb.value);
    if (selectedDays.length === 0) {
      alert("Please select at least one weekday for this preference.");
      return;
    }
    target_day = selectedDays.join(", ");
  }

  try {
    await apiFetch("/api/preferences", {
      method: "POST",
      body: JSON.stringify({
        employee_id,
        type,
        target_dates: type === "date" ? target_dates : null,
        target_date: type === "date" ? target_dates[0] : null,
        target_days: type === "day" ? selectedDays : null,
        target_day: type === "day" ? target_day : null,
        pattern_work_days: type === "pattern" ? pattern_work_days : null,
        pattern_off_days: type === "pattern" ? pattern_off_days : null,
        pattern_start_date: null,
        preference,
        remarks
      })
    });
    closeModal();
    renderPreferencesView();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deletePreference(id) {
  showConfirmModal({
    title: "Delete Staff Preference",
    message: "Are you sure you want to delete this staff preference or pattern?",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/preferences/${id}`, { method: "DELETE" });
        renderPreferencesView();
      } catch (err) {
        alert("Error deleting preference: " + err.message);
      }
    }
  });
}

/* ==========================================================
   VIEW 7: TRAINING RECORDS
   ========================================================= */

async function renderTrainingView() {
  const container = document.getElementById("viewContainer");
  try {
    const list = await apiFetch("/api/training");

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Staff Training Schedules</div>
            <div style="font-size:13px; color:#64748b;">
              Training shifts are logged with code TR and separated from ordinary floor care duty.
            </div>
          </div>
          <button class="btn btn-primary" onclick="openTrainingModal()">
            + Schedule Training
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Staff Name</th>
                <th>Role</th>
                <th>Training Program</th>
                <th>Scheduled Date</th>
                <th>Notes</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.length === 0 ? `<tr><td colspan="6" style="text-align:center; padding:30px; color:#64748b;">No training sessions recorded.</td></tr>` : list.map(t => `
                <tr>
                  <td><strong>${esc(t.employee_name)}</strong></td>
                  <td>${esc(t.designation)}</td>
                  <td>${esc(t.training_name)}</td>
                  <td>${t.training_date || 'Flexible Slot'}</td>
                  <td>${esc(t.notes || '—')}</td>
                  <td style="text-align:right;">
                    <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deleteTraining(${t.id})">
                      Delete
                    </button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

async function openTrainingModal() {
  const employees = await apiFetch("/api/employees");
  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Schedule Staff Training</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveTraining(event)">
          <div class="modal-body">
            <div class="form-group">
              <label>Staff Member</label>
              <select id="trainEmpId" class="form-control" required>
                ${employees.map(e => `<option value="${e.id}">${esc(e.name)} (${esc(e.designation)})</option>`).join('')}
              </select>
            </div>
            <div class="form-group">
              <label>Training Module</label>
              <input type="text" id="trainName" class="form-control" required value="Fire Safety & Manual Handling">
            </div>
            <div class="form-group">
              <label>Training Date</label>
              <input type="date" id="trainDate" class="form-control" value="2026-10-14">
            </div>
            <div class="form-group">
              <label>Notes</label>
              <input type="text" id="trainNotes" class="form-control" placeholder="Optional notes">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Schedule Training</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveTraining(e) {
  e.preventDefault();
  const employee_id = document.getElementById("trainEmpId").value;
  const training_name = document.getElementById("trainName").value;
  const training_date = document.getElementById("trainDate").value;
  const notes = document.getElementById("trainNotes").value;

  try {
    await apiFetch("/api/training", {
      method: "POST",
      body: JSON.stringify({ employee_id, training_name, training_date, notes })
    });
    closeModal();
    renderTrainingView();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteTraining(id) {
  showConfirmModal({
    title: "Delete Training Record",
    message: "Are you sure you want to delete this mandatory training record?",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/training/${id}`, { method: "DELETE" });
        renderTrainingView();
      } catch (err) {
        alert("Error deleting training record: " + err.message);
      }
    }
  });
}

/* ==========================================================
   VIEW 8: ADMIN USER MANAGEMENT (Admin creates email & password)
   ========================================================= */

async function renderUsersView() {
  const container = document.getElementById("viewContainer");
  try {
    const users = await apiFetch("/api/users");

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">User Accounts & Access Control</div>
            <div style="font-size:13px; color:#64748b;">
              Administrators can add email and password credentials for managers and directors.
            </div>
          </div>
          <button class="btn btn-primary" onclick="openUserModal()">
            + Add New User
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>User Name</th>
                <th>Email Address</th>
                <th>Access Level</th>
                <th>Created Date</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(u => `
                <tr>
                  <td><strong>${esc(u.name)}</strong></td>
                  <td>${esc(u.email)}</td>
                  <td>
                    <span class="role-pill" style="background:${u.role === 'admin' ? '#38bdf8' : '#e2e8f0'}; color:${u.role === 'admin' ? '#0b3542' : '#334155'};">
                      ${u.role}
                    </span>
                  </td>
                  <td>${u.created_at ? u.created_at.substring(0, 10) : '—'}</td>
                  <td style="text-align:right;">
                    ${u.id !== currentUser.id ? `
                      <button class="btn btn-danger" style="padding:4px 10px; font-size:12px;" onclick="deleteUser(${u.id})">
                        Delete
                      </button>
                    ` : `<span style="color:#64748b; font-size:12px; font-weight:600;">(Current Account)</span>`}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  } catch (err) {
    container.innerHTML = `<div class="card" style="padding:24px; color:#dc2626;">Error: ${err.message}</div>`;
  }
}

function openUserModal() {
  const content = `
    <div class="modal-overlay">
      <div class="modal-card" style="max-width:520px;">
        <div class="modal-header">
          <div style="display:flex; align-items:center; gap:12px;">
            <div class="card-icon-badge" style="width:38px; height:38px; font-size:16px;">
              👤
            </div>
            <div>
              <h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">Create New User Account</h3>
              <div style="font-size:12px; color:#64748b;">Administrators can grant login credentials</div>
            </div>
          </div>
          <button type="button" class="btn btn-secondary" style="padding:4px 10px; font-weight:800;" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveUser(event)" autocomplete="off">
          <div class="modal-body">
            <div class="form-group">
              <label>Full Name</label>
              <input type="text" id="newUserName" class="form-control" required placeholder="e.g. Sarah Jenkins" autocomplete="off">
            </div>
            <div class="form-group">
              <label>Email Address (Login Username)</label>
              <input type="email" id="newUserEmail" class="form-control" required placeholder="sarah@carehome.com" autocomplete="new-password">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" id="newUserPassword" class="form-control" required placeholder="••••••••" minlength="6" autocomplete="new-password">
              <small style="color:#64748b; font-size:11px; margin-top:4px; display:block;">Minimum 6 characters</small>
            </div>
            <div class="form-group">
              <label>Role / Access Level</label>
              <select id="newUserRole" class="form-control">
                <option value="manager">Manager (Generate Rota, Manage Staff)</option>
                <option value="admin">Administrator (Full System & User Control)</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary" style="padding:9px 20px;">Create User</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveUser(e) {
  e.preventDefault();
  const name = document.getElementById("newUserName").value;
  const email = document.getElementById("newUserEmail").value;
  const password = document.getElementById("newUserPassword").value;
  const role = document.getElementById("newUserRole").value;

  try {
    await apiFetch("/api/users", {
      method: "POST",
      body: JSON.stringify({ name, email, password, role })
    });
    closeModal();
    renderUsersView();
  } catch (err) {
    alert("Error: " + err.message);
  }
}

async function deleteUser(id) {
  showConfirmModal({
    title: "Delete User Account",
    message: "Are you sure you want to delete this user? They will no longer be able to log in.",
    onConfirm: async () => {
      try {
        await apiFetch(`/api/users/${id}`, { method: "DELETE" });
        renderUsersView();
      } catch (err) {
        alert("Error deleting user: " + err.message);
      }
    }
  });
}

/* ==========================================================
   UTILITY HELPERS
   ========================================================= */

function closeModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById("modalContainer").innerHTML = "";
}

function esc(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatShortDate(dStr) {
  if (!dStr) return "";
  const parts = dStr.split("-");
  return `${parts[2]}/${parts[1]}`;
}

// Close open slicer menus when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".dropdown-slicer")) {
    document.querySelectorAll(".slicer-popup-card").forEach(el => el.style.display = "none");
    openSlicerMenuId = null;
  }
});

// Kick off initialization
document.addEventListener("DOMContentLoaded", initApp);
