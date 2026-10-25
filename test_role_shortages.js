const { generateRotaForPeriod } = require('./rotaEngine');

async function test() {
  const r = await generateRotaForPeriod('2026-10-05', '2026-11-01');
  const val = r.rota.filter(x => x.employeeName === 'Valerie Fairley');
  console.log('Valerie Fairley:');
  val.forEach(x => console.log(`${x.date} (${x.dayName}): ${x.shift}`));

  console.log('\n--- Day by Day Night Shortage Breakdown (by Role) ---');
  // Let's compute which role was short on each day
  r.calendarDays.forEach(day => {
    const dStr = day.dateString;
    const nightAssigned = r.rota.filter(x => x.date === dStr && x.shift === 'N');
    const roleCounts = {};
    nightAssigned.forEach(x => {
      roleCounts[x.designation] = (roleCounts[x.designation] || 0) + 1;
    });

    const snShort = Math.max(0, 3 - (roleCounts['Staff Nurse'] || 0));
    const scShort = Math.max(0, 2 - (roleCounts['Senior Carer'] || 0));
    const cShort = Math.max(0, 7 - (roleCounts['Carer'] || 0));
    const totalShort = snShort + scShort + cShort;

    if (totalShort > 0) {
      console.log(`${dStr} (${day.dayName}): Total Night Short: ${totalShort} -> [Staff Nurse: -${snShort}, Senior Carer: -${scShort}, Carer: -${cShort}]`);
    }
  });
}
test();
