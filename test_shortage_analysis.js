const { generateRotaForPeriod } = require('./rotaEngine');
const db = require('./database');

async function test() {
  const result = await generateRotaForPeriod('2026-10-05', '2026-11-01');
  console.log('--- Shortages by Day ---');
  let totalShortages = 0;
  let dayShortages = 0;
  let nightShortages = 0;

  result.dailyShortages.forEach(d => {
    if (d.dayShortage > 0 || d.nightShortage > 0) {
      console.log(`${d.date} (${d.dayName}): Day Req ${d.dayRequired}, Allotted ${d.dayAllotted}, Short ${d.dayShortage} | Night Req ${d.nightRequired}, Allotted ${d.nightAllotted}, Short ${d.nightShortage}`);
      dayShortages += d.dayShortage;
      nightShortages += d.nightShortage;
      totalShortages += (d.dayShortage + d.nightShortage);
    }
  });

  console.log('\n--- Summary ---');
  console.log(`Total shortages: ${totalShortages}`);
  console.log(`Day shortages: ${dayShortages}`);
  console.log(`Night shortages: ${nightShortages}`);

  // Let's also inspect staff supply vs demand for nights
  const employees = db.prepare('SELECT * FROM employees WHERE active = 1').all();
  const requirements = db.prepare('SELECT * FROM requirements').all();
  const preferences = db.prepare('SELECT * FROM preferences').all();

  console.log('\n--- Requirements (Daily) ---');
  requirements.forEach(r => {
    console.log(`${r.role_name}: Day ${r.day_required}, Night ${r.night_required}`);
  });

  console.log('\n--- Employees count by role & staff_type ---');
  const roleStats = {};
  employees.forEach(e => {
    if (!roleStats[e.designation]) {
      roleStats[e.designation] = { total: 0, night: 0, day: 0, totalContractHours: 0 };
    }
    roleStats[e.designation].total++;
    roleStats[e.designation].totalContractHours += e.contract_hours;
    if (e.staff_type === 'N') roleStats[e.designation].night++;
    else roleStats[e.designation].day++;
  });
  console.log(roleStats);

  console.log('\n--- Preferences Count ---');
  console.log('Total preferences:', preferences.length);
  const unavail = preferences.filter(p => p.preference === 'unavailable');
  console.log('Unavailable preferences:', unavail.length);
}

test();
