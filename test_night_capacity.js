const db = require('./database');

const employees = db.prepare("SELECT * FROM employees WHERE staff_type = 'N' AND active = 1").all();
console.log('--- Night Staff Details ---');
let totalNightHours = 0;
let totalNightShifts = 0;

employees.forEach(e => {
  const shifts = Math.floor(e.contract_hours / e.shift_hours);
  totalNightHours += e.contract_hours;
  totalNightShifts += shifts;
  console.log(`${e.id} | ${e.name.padEnd(20)} | ${e.designation.padEnd(15)} | ${e.contract_hours}h (${shifts} shf @ ${e.shift_hours}h)`);
});

console.log(`\nTotal Night Staff: ${employees.length}`);
console.log(`Total Contract Hours: ${totalNightHours}h/week`);
console.log(`Total Shift Capacity: ${totalNightShifts} shifts/week`);
console.log(`Required Night Capacity: 84 shifts/week (12 shifts/night * 7 nights)`);
console.log(`Deficit in capacity: ${totalNightShifts - 84} shifts/week!`);
