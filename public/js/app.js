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

function showLogin() {
  document.getElementById("loginSection").style.display = "flex";
  document.getElementById("appSection").style.display = "none";
}

function showApp() {
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("appSection").style.display = "block";

  document.getElementById("navUserName").textContent = currentUser.name;
  document.getElementById("navUserRole").textContent = currentUser.role;

  // Show Admin Users Tab only for Admin
  if (currentUser.role === "admin") {
    document.getElementById("adminUsersTab").style.display = "block";
  } else {
    document.getElementById("adminUsersTab").style.display = "none";
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

    let html = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">4-Week Monday-to-Sunday Cycle Scheduler</div>
            <div style="font-size:13px; color:#64748b; margin-top:2px;">
              Period: <strong>${currentRotaData.periodLabel}</strong> &nbsp;•&nbsp; 28 Days Active (${calendarDays[0].dateString} – ${calendarDays[27].dateString})
            </div>
          </div>

          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <select id="rotaPeriodSelect" class="form-control" style="width:auto; font-weight:600;">
              <option value="P10_2026" data-start="2026-09-28" data-end="2026-10-25" selected>Period 10 (2026): 28 Sep – 25 Oct</option>
              <option value="P11_2026" data-start="2026-10-26" data-end="2026-11-22">Period 11 (2026): 26 Oct – 22 Nov</option>
              <option value="P12_2026" data-start="2026-11-23" data-end="2026-12-20">Period 12 (2026): 23 Nov – 20 Dec</option>
            </select>

            <button class="btn btn-primary" onclick="triggerGenerateRota()">
              ⚡ Generate Rota
            </button>
            <button class="btn btn-secondary" onclick="exportRotaToExcel()">
              📅 Download Excel
            </button>
            <button class="btn btn-secondary" onclick="printRotaLandscape()">
              🖨️ Print
            </button>
          </div>
        </div>

        <!-- Rota Sub-Navigation & Overlapping Rules Button -->
        <div style="padding:12px 20px; background:#f8fafc; border-bottom:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
          <div style="display:flex; gap:6px; background:#e2e8f0; padding:4px; border-radius:8px;">
            <button class="btn ${rotaSubView === 'weekly' ? 'btn-primary' : 'btn-secondary'}" style="padding:6px 14px; font-size:13px;" onclick="setRotaSubView('weekly')">
              📅 Weekly Shift Schedule
            </button>
            <button class="btn ${rotaSubView === 'monthly' ? 'btn-primary' : 'btn-secondary'}" style="padding:6px 14px; font-size:13px;" onclick="setRotaSubView('monthly')">
              👤 Staff-wise Monthly Matrix (28 Days)
            </button>
            <button class="btn ${rotaSubView === 'balances' ? 'btn-primary' : 'btn-secondary'}" style="padding:6px 14px; font-size:13px;" onclick="setRotaSubView('balances')">
              💰 Contract Hours & Balances
            </button>
          </div>

          <div>
            <button class="btn btn-secondary" onclick="openRuleConflictsModal()" style="border-color:#f59e0b; background:#fffbeb; color:#b45309; font-weight:700; display:inline-flex; align-items:center; gap:8px;">
              <span>📅</span> Daily Shortages & Conflicting Rules
              <span style="background:#dc2626; color:#ffffff; border-radius:10px; padding:1px 8px; font-size:11px; font-weight:800;">
                ${(currentRotaData.clashes || []).length} Shortages
              </span>
            </button>
          </div>
        </div>
    `;

    if (rotaSubView === "weekly") {
      html += `
        <!-- Week Filter Pills -->
        <div style="padding:14px 20px; border-bottom:1px solid #e2e8f0; display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn ${selectedWeek === 'all' ? 'btn-primary' : 'btn-secondary'}" onclick="setRotaWeek('all')">
            📋 All Weeks (4)
          </button>
          ${weeks.map(w => `
            <button class="btn ${String(selectedWeek) === String(w.num) ? 'btn-primary' : 'btn-secondary'}" onclick="setRotaWeek('${w.num}')">
              Week ${w.num} (${formatShortDate(w.days[0].dateString)} - ${formatShortDate(w.days[6].dateString)})
            </button>
          `).join('')}
        </div>

        <!-- Legend -->
        <div style="padding:10px 20px; background:#f8fafc; border-bottom:1px solid #e2e8f0; font-size:12px; display:flex; gap:16px; flex-wrap:wrap; font-weight:600;">
          <span><span class="status-pill status-D">D</span> Day Shift</span>
          <span><span class="status-pill status-N">N</span> Night Shift</span>
          <span><span class="status-pill status-OFF">OFF</span> Off Duty</span>
          <span><span class="status-pill status-L">L</span> Approved Leave</span>
          <span><span class="status-pill status-TR">TR</span> Training</span>
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
            <div class="card-header" style="background:#f1f5f9;">
              <div style="font-weight:800; font-size:16px; color:#0b3542;">
                WEEK ${week.num} SCHEDULE &nbsp;•&nbsp; ${days[0].dateString} to ${days[6].dateString}
              </div>
            </div>

            <!-- ☀️ DAY SHIFT TABLE -->
            <div class="shift-section-title shift-day-title">
              <span>☀️ DAY SHIFT SCHEDULE</span>
              <span>Day Staff Active: ${dayStaff.length}</span>
            </div>

            <div class="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th style="min-width:200px;">Staff Name</th>
                    <th style="min-width:160px;">Role</th>
                    <th style="min-width:160px;">Contract Target</th>
                    ${days.map((d, idx) => `
                      <th style="text-align:center; min-width:85px; ${dayAllotted[idx] < dailyRequiredTotals.day ? 'background:#fff1f2;' : ''}">
                        <strong>${d.dayName.substring(0,3)}</strong><br>
                        <small style="opacity:0.8;">${formatShortDate(d.dateString)}</small>
                        ${dayAllotted[idx] < dailyRequiredTotals.day ? `<br><span style="font-size:10px; background:#fee2e2; color:#dc2626; padding:1px 4px; border-radius:3px;">Short</span>` : ''}
                      </th>
                    `).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${dayStaff.map(st => {
                    const targetThisWeek = st.weeklyTargets[week.num - 1] || 0;
                    return `
                      <tr>
                        <td><strong>${esc(st.employeeName)}</strong></td>
                        <td>${esc(st.designation)}</td>
                        <td>${st.contractHours}h <span style="color:#059669; font-size:12px; font-weight:700;">(Tgt: ${targetThisWeek} shf)</span></td>
                        ${days.map(d => {
                          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                          const status = rec ? rec.status : "OFF";
                          return `<td style="text-align:center;"><span class="status-pill status-${status}">${status}</span></td>`;
                        }).join('')}
                      </tr>
                    `;
                  }).join('')}

                  <!-- REQUIRED STAFF ROW -->
                  <tr style="background:#f8fafc; font-weight:700; border-top:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#475569;">Required Staff:</td>
                    ${days.map(() => `<td style="text-align:center; color:#475569; font-weight:700;">${dailyRequiredTotals.day}</td>`).join('')}
                  </tr>

                  <!-- ALLOTTED STAFF ROW -->
                  <tr style="background:#f1f5f9; font-weight:800;">
                    <td colspan="3" style="text-align:right; color:#0f172a;">Allotted Staff:</td>
                    ${days.map((d, idx) => `<td style="text-align:center; color:#0f172a; font-size:14px; font-weight:800;">${dayAllotted[idx]}</td>`).join('')}
                  </tr>

                  <!-- SHORTAGE ROW (Highlighted in Red if < Required) -->
                  <tr style="background:#ffffff; font-weight:800; border-bottom:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#0f172a; vertical-align:middle;">Shortage:</td>
                    ${days.map((d, idx) => {
                      const ds = shortageMap[d.dateString];
                      const short = ds ? ds.dayShortage : Math.max(0, dailyRequiredTotals.day - dayAllotted[idx]);
                      if (short > 0) {
                        const breakdown = (ds && ds.dayBreakdown) ? ds.dayBreakdown : [];
                        return `
                          <td style="text-align:center; color:#dc2626; background:#fee2e2; border:1px solid #fca5a5; padding:6px 4px; vertical-align:top;">
                            <div style="display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:3px;">
                              <span style="font-size:13px; font-weight:800; color:#b91c1c;">-${short}</span>
                              <button type="button" onclick="openShortageDetail('${d.dateString}', 'D')" title="Click to view reasons for this shortage" style="background:#b91c1c; color:#ffffff; border:none; border-radius:50%; width:18px; height:18px; font-size:11px; line-height:18px; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.2);">ℹ</button>
                            </div>
                            <div style="font-size:10px; line-height:1.2; color:#991b1b; font-weight:600;">
                              ${breakdown.map(b => `<div style="margin-top:2px; white-space:nowrap;">-${b.shortage} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      }
                      return `<td style="text-align:center; color:#15803d; background:#dcfce7; font-weight:700; border:1px solid #86efac; font-size:12px; vertical-align:middle;">0 ✅</td>`;
                    }).join('')}
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 🌙 NIGHT SHIFT TABLE -->
            <div class="shift-section-title shift-night-title">
              <span>🌙 NIGHT SHIFT SCHEDULE</span>
              <span>Night Staff Active: ${nightStaff.length}</span>
            </div>

            <div class="table-responsive">
              <table class="night-table">
                <thead>
                  <tr>
                    <th style="min-width:200px;">Staff Name</th>
                    <th style="min-width:160px;">Role</th>
                    <th style="min-width:160px;">Contract Target</th>
                    ${days.map((d, idx) => `
                      <th style="text-align:center; min-width:85px;">
                        <strong>${d.dayName.substring(0,3)}</strong><br>
                        <small>${formatShortDate(d.dateString)}</small>
                        ${nightAllotted[idx] < dailyRequiredTotals.night ? `<br><span style="font-size:10px; background:#ef4444; color:#ffffff; padding:1px 4px; border-radius:3px;">Short</span>` : ''}
                      </th>
                    `).join('')}
                  </tr>
                </thead>
                <tbody>
                  ${nightStaff.map(st => {
                    const targetThisWeek = st.weeklyTargets[week.num - 1] || 0;
                    return `
                      <tr>
                        <td><strong>${esc(st.employeeName)}</strong></td>
                        <td>${esc(st.designation)}</td>
                        <td>${st.contractHours}h <span style="color:#059669; font-size:12px; font-weight:700;">(Tgt: ${targetThisWeek} shf)</span></td>
                        ${days.map(d => {
                          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
                          const status = rec ? rec.status : "OFF";
                          return `<td style="text-align:center;"><span class="status-pill status-${status}">${status}</span></td>`;
                        }).join('')}
                      </tr>
                    `;
                  }).join('')}

                  <!-- REQUIRED STAFF ROW -->
                  <tr style="background:#f8fafc; font-weight:700; border-top:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#475569;">Required Staff:</td>
                    ${days.map(() => `<td style="text-align:center; color:#475569; font-weight:700;">${dailyRequiredTotals.night}</td>`).join('')}
                  </tr>

                  <!-- ALLOTTED STAFF ROW -->
                  <tr style="background:#f1f5f9; font-weight:800;">
                    <td colspan="3" style="text-align:right; color:#0f172a;">Allotted Staff:</td>
                    ${days.map((d, idx) => `<td style="text-align:center; color:#0f172a; font-size:14px; font-weight:800;">${nightAllotted[idx]}</td>`).join('')}
                  </tr>

                  <!-- SHORTAGE ROW -->
                  <tr style="background:#ffffff; font-weight:800; border-bottom:2px solid #cbd5e1;">
                    <td colspan="3" style="text-align:right; color:#0f172a; vertical-align:middle;">Shortage:</td>
                    ${days.map((d, idx) => {
                      const ds = shortageMap[d.dateString];
                      const short = ds ? ds.nightShortage : Math.max(0, dailyRequiredTotals.night - nightAllotted[idx]);
                      if (short > 0) {
                        const breakdown = (ds && ds.nightBreakdown) ? ds.nightBreakdown : [];
                        return `
                          <td style="text-align:center; color:#dc2626; background:#fee2e2; border:1px solid #fca5a5; padding:6px 4px; vertical-align:top;">
                            <div style="display:flex; align-items:center; justify-content:center; gap:4px; margin-bottom:3px;">
                              <span style="font-size:13px; font-weight:800; color:#b91c1c;">-${short}</span>
                              <button type="button" onclick="openShortageDetail('${d.dateString}', 'N')" title="Click to view reasons for this shortage" style="background:#b91c1c; color:#ffffff; border:none; border-radius:50%; width:18px; height:18px; font-size:11px; line-height:18px; cursor:pointer; padding:0; display:inline-flex; align-items:center; justify-content:center; font-weight:bold; box-shadow:0 1px 2px rgba(0,0,0,0.2);">ℹ</button>
                            </div>
                            <div style="font-size:10px; line-height:1.2; color:#991b1b; font-weight:600;">
                              ${breakdown.map(b => `<div style="margin-top:2px; white-space:nowrap;">-${b.shortage} ${esc(b.role)}</div>`).join('')}
                            </div>
                          </td>
                        `;
                      }
                      return `<td style="text-align:center; color:#15803d; background:#dcfce7; font-weight:700; border:1px solid #86efac; font-size:12px; vertical-align:middle;">0 ✅</td>`;
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
            ` : filteredStaff.map(st => {
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
                  <td style="text-align:center; padding:4px; border-right:1px solid #e2e8f0; font-size:11px; font-weight:600; color:#475569;">
                    ${st.netTargetHours}h
                  </td>
                  <td style="text-align:center; padding:4px; border-right:2px solid #0b3542; font-size:11px; font-weight:700; ${st.floorHoursWorked < st.netTargetHours ? 'color:#dc2626;' : 'color:#15803d;'}">
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
                const isWkStart = idx % 7 === 0;
                return `
                  <td class="${isWkStart ? 'week-sep-left' : ''}" style="text-align:center; font-size:11px; padding:4px 1px; ${isShort ? 'background:#fee2e2; color:#b91c1c;' : 'color:#0f172a;'}">
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
                const isWkStart = idx % 7 === 0;
                return `
                  <td class="${isWkStart ? 'week-sep-left' : ''}" style="text-align:center; font-size:11px; padding:4px 1px; ${isShort ? 'background:#fee2e2; color:#b91c1c;' : 'color:#0f172a;'}">
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
    <!-- Top KPI Stat Cards -->
    <div class="stat-grid" style="margin-top:20px;">
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
        <div class="stat-card-val" style="color:#2563eb;">${totalLeaveDedHours.toLocaleString()} <span style="font-size:14px; font-weight:600; color:#64748b;">hrs</span></div>
        <div class="stat-card-desc">${balances.reduce((s,b)=>s+(b.leaveDays||0),0)} approved leave days deducted</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-title">⚖️ Carried Forward Balance</div>
        <div class="stat-card-val" style="${totalBalanceRemaining > 0 ? 'color:#d97706;' : 'color:#059669;'}">
          ${totalBalanceRemaining.toLocaleString()} <span style="font-size:14px; font-weight:600; color:#64748b;">hrs</span>
        </div>
        <div class="stat-card-desc">${carriedOverStaffCount} staff carried to next period</div>
      </div>

      <div class="stat-card">
        <div class="stat-card-title">🎯 Fulfillment Rate</div>
        <div class="stat-card-val" style="color:#0b3542;">${fulfillmentRatePct}%</div>
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

      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th style="min-width:180px;">Staff Member</th>
              <th style="min-width:140px;">Role</th>
              <th style="min-width:80px; text-align:center;">Type</th>
              <th style="min-width:110px; text-align:center;">Weekly Contract</th>
              <th style="min-width:110px; text-align:center;">4-Wk Base Hrs</th>
              <th style="min-width:120px; text-align:center;">Leave Deduct</th>
              <th style="min-width:120px; text-align:center;">Net Target</th>
              <th style="min-width:130px; text-align:center;">Floor Worked</th>
              <th style="min-width:120px; text-align:center;">Balance</th>
              <th style="min-width:140px;">Target Progress</th>
              <th style="min-width:110px; text-align:center;">Status</th>
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
                  <td style="text-align:center; font-weight:800; ${isFulfilled ? 'color:#15803d;' : 'color:#d97706;'}">
                    ${isFulfilled ? '0h' : `+${b.balanceRemaining}h`}
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
                      <span class="badge" style="background:#fef3c7; color:#b45309; font-weight:700; padding:3px 8px; border-radius:4px; font-size:11px;" title="Carried forward to next period per rule">
                        Carried +${b.balanceRemaining}h ⚖️
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
  if (!currentRotaData || !currentRotaData.dailyShortages) return;
  const ds = currentRotaData.dailyShortages.find(d => d.date === dateString);
  if (!ds) return;

  const isDay = shiftType === "D";
  const shiftName = isDay ? "Day Shift" : "Night Shift";
  const reqTotal = isDay ? ds.dayRequired : ds.nightRequired;
  const allotTotal = isDay ? ds.dayAllotted : ds.nightAllotted;
  const shortTotal = isDay ? ds.dayShortage : ds.nightShortage;
  const breakdown = isDay ? (ds.dayBreakdown || []) : (ds.nightBreakdown || []);

  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" style="max-width:680px;" onclick="event.stopPropagation()">
        <div class="modal-header" style="background:#fef2f2; border-bottom:2px solid #fecaca;">
          <div>
            <h3 style="color:#991b1b; margin:0; font-size:18px; display:flex; align-items:center; gap:8px;">
              <span>🚨</span> ${ds.dayName}, ${ds.date} — ${shiftName} Shortage Diagnostics
            </h3>
            <div style="font-size:12px; color:#7f1d1d; margin-top:4px;">
              Staffing Quota: Required <strong>${reqTotal}</strong> • Allotted <strong>${allotTotal}</strong> • Deficit <strong style="color:#b91c1c;">-${shortTotal} staff</strong>
            </div>
          </div>
          <button class="btn btn-secondary" onclick="closeModal()" style="padding:4px 10px; font-weight:bold;">✕</button>
        </div>
        <div class="modal-body" style="max-height:500px; overflow-y:auto; padding:20px;">
          <div style="font-size:13px; color:#475569; margin-bottom:16px;">
            The detailed breakdown below outlines why staff for each required role could not be allocated on this shift:
          </div>

          ${breakdown.length === 0 ? `<div style="color:#15803d; font-weight:600;">No role shortages detected for this shift.</div>` : `
            ${breakdown.map(b => {
              const directReasons = (b.reasons || []).filter(r => !r.reason.includes("not contracted"));
              const otherReasons = (b.reasons || []).filter(r => r.reason.includes("not contracted"));

              return `
                <div style="background:#ffffff; border:1.5px solid #fca5a5; border-radius:8px; padding:14px 16px; margin-bottom:14px; box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                  <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #fee2e2; padding-bottom:8px; margin-bottom:10px;">
                    <div style="font-weight:800; font-size:15px; color:#991b1b;">
                      ${esc(b.role)}: Shortage of -${b.shortage}
                    </div>
                    <div style="font-size:12px; font-weight:700; background:#fee2e2; color:#b91c1c; padding:2px 8px; border-radius:4px;">
                      Required: ${b.required} | Allotted: ${b.allotted}
                    </div>
                  </div>

                  <div style="font-size:12px; font-weight:700; color:#334155; margin-bottom:6px;">
                    Candidate Availability Status:
                  </div>

                  ${directReasons.length === 0 ? `
                    <div style="font-size:12px; color:#64748b; font-style:italic; margin-bottom:6px;">
                      No contracted ${esc(b.role)} staff available for this shift type.
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
          `}
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



function openRuleConflictsModal(dateToSelect) {
  if (dateToSelect && typeof dateToSelect === "string") {
    currentConflictSearch = dateToSelect;
    currentConflictOnlyShortages = false;
  }
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
  const { calendarDays, dailyShortages, dailyRequiredTotals } = currentRotaData;
  const days = calendarDays || [];
  const shortagesList = dailyShortages || [];

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
      <div class="modal-card" style="max-width:960px; width:95vw;" onclick="event.stopPropagation()">
        <div class="modal-header" style="background:#fffbeb; border-bottom:2px solid #fde68a;">
          <div>
            <h3 style="color:#92400e; margin:0; font-size:18px; display:flex; align-items:center; gap:8px;">
              <span>📅</span> Daily Shortages & Conflicting Rules Guide
            </h3>
            <div style="font-size:12px; color:#78350f; margin-top:4px;">
              Date-by-date breakdown of staffing shortages and the exact safety, rest, or leave rules active on each date.
            </div>
          </div>
          <button class="btn btn-secondary" onclick="closeModal()" style="padding:4px 10px; font-weight:bold;">✕</button>
        </div>

        <div class="modal-body" style="padding:16px 20px;">
          <!-- Filter Controls -->
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
                            <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:4px 10px; font-size:12px; display:inline-flex; align-items:center; gap:6px;">
                              <strong style="color:#991b1b;">${esc(b.role)}:</strong>
                              <span style="color:#b91c1c; font-weight:800;">-${b.shortage}</span>
                              <span style="color:#64748b; font-size:11px;">(${b.allotted} on duty / ${b.required} required)</span>
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
        </div>

        <div class="modal-footer" style="background:#f8fafc; border-top:1px solid #e2e8f0; display:flex; justify-content:space-between; align-items:center;">
          <div style="font-size:12px; color:#64748b;">
            💡 <em>Showing only relevant conflicting rules (4-day streak, night turnaround, leave, training). Overtime / overstaffing strictly prevented.</em>
          </div>
          <button class="btn btn-secondary" onclick="closeModal()">Close Guide</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("modalContainer").innerHTML = content;
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

          dayStaffList.forEach((st, idx) => {
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
            applyDataRowStyle(row, idx % 2 === 1);
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

          nightStaffList.forEach((st, idx) => {
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

        const staffList = [...balances].sort((a, b) => a.designation.localeCompare(b.designation) || a.employeeName.localeCompare(b.employeeName));
        staffList.forEach((st, idx) => {
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
          applyDataRowStyle(row, idx % 2 === 1);
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
    const staffList = [...balances].sort((a, b) => a.designation.localeCompare(b.designation) || a.employeeName.localeCompare(b.employeeName));

    weeks.forEach(w => {
      // 1. Day Sheet
      const dayStaffList = staffList.filter(st => {
        if (st.staffType === "D") return true;
        return w.days.some(d => {
          const rec = rota.find(r => r.employeeId === st.employeeId && r.date === d.dateString);
          return rec && rec.shift === "D";
        });
      });

      const dayRows = dayStaffList.map(st => {
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
        return row;
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

      const nightRows = nightStaffList.map(st => {
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
    const rows = balances.map(st => {
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
      return row;
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
            ${dayStaff.map(st => {
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
            ${nightStaff.map(st => {
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
   VIEW 2: STAFF MANAGEMENT (Backend ID Hidden, Custom Shift Hours)
   ========================================================= */

async function renderEmployeesView() {
  const container = document.getElementById("viewContainer");
  try {
    const employees = await apiFetch("/api/employees");

    container.innerHTML = `
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Staff Members Registry</div>
            <div style="font-size:13px; color:#64748b;">
              Total: ${employees.length} employees (System automatically manages backend ID)
            </div>
          </div>
          <button class="btn btn-primary" onclick="openEmployeeModal()">
            + Add Staff Member
          </button>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Staff Name</th>
                <th>Role / Designation</th>
                <th>Weekly Contract</th>
                <th style="background:#e0f2fe; color:#0369a1;">Shift Duration</th>
                <th>Shift Type</th>
                <th>Status</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${employees.map(emp => `
                <tr>
                  <td><strong>${esc(emp.name)}</strong></td>
                  <td>${esc(emp.designation)}</td>
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

function openEmployeeModal(emp = null) {
  const isEdit = !!emp;
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
                ${['Carer', 'Senior Carer', 'Staff Nurse', 'Team Leader', 'Advanced Team Leader', 'Clinical Lead', 'Dy. Manager', 'Wellbeing Staff', 'Hostes', 'Maintance Staff', 'Physiotherapist'].map(r => `
                  <option value="${r}" ${emp && emp.designation === r ? 'selected' : ''}>${r}</option>
                `).join('')}
              </select>
            </div>

            <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
              <div class="form-group">
                <label>Weekly Contract Hours</label>
                <input type="number" step="0.5" id="empContract" class="form-control" required value="${emp ? emp.contract_hours : '44'}">
              </div>

              <div class="form-group">
                <label>Shift Duration (Hours)</label>
                <input type="number" step="0.5" id="empShiftHours" class="form-control" required value="${emp ? (emp.shift_hours || 11) : '11'}">
                <small style="color:#64748b; font-size:11px;">Default is 11 hours per shift</small>
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
  const contract_hours = parseFloat(document.getElementById("empContract").value) || 44;
  const shift_hours = parseFloat(document.getElementById("empShiftHours").value) || 11;
  const staff_type = document.getElementById("empShiftType").value;
  const active = parseInt(document.getElementById("empActive").value, 10);

  try {
    if (empId) {
      await apiFetch(`/api/employees/${empId}`, {
        method: "PUT",
        body: JSON.stringify({ name, designation, contract_hours, shift_hours, staff_type, active })
      });
    } else {
      await apiFetch("/api/employees", {
        method: "POST",
        body: JSON.stringify({ name, designation, contract_hours, shift_hours, staff_type, active })
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
                <th style="width:80px; text-align:center;">Priority</th>
                <th>Required Role</th>
                <th style="background:#e6f6ec; color:#15803d;">Substitute 1</th>
                <th>Substitute 2</th>
                <th>Substitute 3</th>
                <th>Substitute 4</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${list.map(h => `
                <tr>
                  <td style="text-align:center; font-weight:800; font-size:14px; color:#0b3542;">${h.priority}</td>
                  <td><strong>${esc(h.required_role)}</strong></td>
                  <td style="font-weight:600; color:#15803d;">${esc(h.substitute_1 || '—')}</td>
                  <td>${esc(h.substitute_2 || '—')}</td>
                  <td>${esc(h.substitute_3 || '—')}</td>
                  <td>${esc(h.substitute_4 || '—')}</td>
                  <td style="text-align:right;">
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

function openHierarchyModal() {
  const content = `
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Add Role Substitution Rule</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveHierarchy(event)">
          <div class="modal-body">
            <div style="display:grid; grid-template-columns:120px 1fr; gap:16px;">
              <div class="form-group">
                <label>Priority</label>
                <input type="number" id="hierPri" class="form-control" required value="1">
              </div>
              <div class="form-group">
                <label>Required Role</label>
                <input type="text" id="hierReq" class="form-control" required placeholder="e.g. Staff Nurse">
              </div>
            </div>

            <div class="form-group">
              <label>Substitute 1 (First Backup)</label>
              <input type="text" id="hierSub1" class="form-control" placeholder="e.g. Team Leader">
            </div>
            <div class="form-group">
              <label>Substitute 2</label>
              <input type="text" id="hierSub2" class="form-control" placeholder="e.g. Senior Carer">
            </div>
            <div class="form-group">
              <label>Substitute 3</label>
              <input type="text" id="hierSub3" class="form-control">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Save Rule</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById("modalContainer").innerHTML = content;
}

async function saveHierarchy(e) {
  e.preventDefault();
  const priority = document.getElementById("hierPri").value;
  const required_role = document.getElementById("hierReq").value;
  const substitute_1 = document.getElementById("hierSub1").value;
  const substitute_2 = document.getElementById("hierSub2").value;
  const substitute_3 = document.getElementById("hierSub3").value;

  try {
    await apiFetch("/api/hierarchy", {
      method: "POST",
      body: JSON.stringify({ priority, required_role, substitute_1, substitute_2, substitute_3 })
    });
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
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:12px;">
                <div>
                  <label style="font-size:12px; font-weight:700;">Working Days in Block</label>
                  <input type="number" id="patternWork" class="form-control" value="4" min="1" max="14">
                </div>
                <div>
                  <label style="font-size:12px; font-weight:700;">Rest Days in Block</label>
                  <input type="number" id="patternOff" class="form-control" value="2" min="1" max="14">
                </div>
              </div>
              <div>
                <label style="font-size:12px; font-weight:700;">Pattern Anchor / Start Date</label>
                <input type="date" id="patternStart" class="form-control" value="2026-09-28">
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

            <!-- RECURRING DAY INPUT -->
            <div id="daySection" style="display:none;" class="form-group">
              <label>Recurring Day of Week</label>
              <select id="prefDay" class="form-control">
                <option value="Monday">Monday</option>
                <option value="Tuesday">Tuesday</option>
                <option value="Wednesday">Wednesday</option>
                <option value="Thursday">Thursday</option>
                <option value="Friday">Friday</option>
                <option value="Saturday">Saturday</option>
                <option value="Sunday">Sunday</option>
              </select>
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
  const target_day = document.getElementById("prefDay").value;
  const pattern_work_days = document.getElementById("patternWork").value;
  const pattern_off_days = document.getElementById("patternOff").value;
  const pattern_start_date = document.getElementById("patternStart").value;
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

  try {
    await apiFetch("/api/preferences", {
      method: "POST",
      body: JSON.stringify({
        employee_id,
        type,
        target_dates: type === "date" ? target_dates : null,
        target_date: type === "date" ? target_dates[0] : null,
        target_day: type === "day" ? target_day : null,
        pattern_work_days: type === "pattern" ? pattern_work_days : null,
        pattern_off_days: type === "pattern" ? pattern_off_days : null,
        pattern_start_date: type === "pattern" ? pattern_start_date : null,
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
    <div class="modal-overlay" onclick="closeModal(event)">
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-header">
          <h3>Create New User Account</h3>
          <button class="btn btn-secondary" onclick="closeModal()">✕</button>
        </div>
        <form onsubmit="saveUser(event)">
          <div class="modal-body">
            <div class="form-group">
              <label>Full Name</label>
              <input type="text" id="newUserName" class="form-control" required placeholder="e.g. Sarah Jenkins">
            </div>
            <div class="form-group">
              <label>Email Address (Login Username)</label>
              <input type="email" id="newUserEmail" class="form-control" required placeholder="sarah@carehome.com">
            </div>
            <div class="form-group">
              <label>Password</label>
              <input type="password" id="newUserPassword" class="form-control" required placeholder="••••••••" minlength="6">
            </div>
            <div class="form-group">
              <label>Role</label>
              <select id="newUserRole" class="form-control">
                <option value="manager">Manager (Generate Rota, Manage Staff)</option>
                <option value="admin">Administrator (Full System & User Control)</option>
              </select>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button type="submit" class="btn btn-primary">Create User</button>
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

// Kick off initialization
document.addEventListener("DOMContentLoaded", initApp);
