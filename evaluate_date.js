const { generateRotaForPeriod } = require('./rotaEngine');
const db = require('./database');

async function evaluateDate(targetDateStr) {
  const result = await generateRotaForPeriod('2026-10-05', '2026-11-01');
  const dayShortage = result.dailyShortages.find(d => d.date === targetDateStr);
  console.log(`\n=== EVALUATION FOR DATE: ${targetDateStr} (${dayShortage.dayName}) ===`);
  console.log(`Day Shift: Required ${dayShortage.dayRequired}, Allotted ${dayShortage.dayAllotted}, Shortage ${dayShortage.dayShortage}`);
  console.log(`Night Shift: Required ${dayShortage.nightRequired}, Allotted ${dayShortage.nightAllotted}, Shortage ${dayShortage.nightShortage}`);

  // Find who was allotted on this date
  const allottedNight = result.rota.filter(r => r.date === targetDateStr && r.shift === 'N');
  console.log(`\nAllotted Night Staff (${allottedNight.length}):`);
  allottedNight.forEach(a => console.log(` - ${a.employeeName} (${a.designation})`));

  // Inspect ALL night staff and why each was or wasn't assigned on this date
  const nightStaff = db.prepare("SELECT * FROM employees WHERE staff_type = 'N' AND active = 1").all();
  console.log(`\n--- Night Staff Status on ${targetDateStr} (Total ${nightStaff.length} night staff) ---`);

  // Target date is in Week 2 (2026-10-12 is Monday of Week 2)
  nightStaff.forEach(emp => {
    // Find all shifts of this employee in Week 2 (2026-10-12 to 2026-10-18)
    const weekShifts = result.rota.filter(r => r.employeeName === emp.name && r.date >= '2026-10-12' && r.date <= '2026-10-18' && (r.shift === 'D' || r.shift === 'N'));
    const onDate = result.rota.find(r => r.employeeName === emp.name && r.date === targetDateStr);
    const prevSunday = result.rota.find(r => r.employeeName === emp.name && r.date === '2026-10-11');

    const statusOnDate = onDate ? onDate.shift : 'OFF';
    const workedSunday = prevSunday && (prevSunday.shift === 'D' || prevSunday.shift === 'N');

    console.log(`${emp.id} | ${emp.name.padEnd(20)} | ${emp.designation.padEnd(12)} | ${statusOnDate} on ${targetDateStr} | Worked Sun: ${workedSunday ? 'YES' : 'NO '} | Wk2 Shifts: ${weekShifts.length}/${Math.floor(emp.contract_hours/11)}`);
  });
}

evaluateDate('2026-10-12');
