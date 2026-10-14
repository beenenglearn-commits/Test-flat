import * as P from './periods.js';
let pass=0,fail=0;const ok=(n,c)=>{c?pass++:(fail++,console.log('FAIL',n));};
// leap years
ok('leap 2024',P.isLeap(2024)&&!P.isLeap(2100)&&P.isLeap(2000)&&!P.isLeap(2026));
ok('feb',P.daysInMonth(2024,2)===29&&P.daysInMonth(2026,2)===28);
ok('year days',P.daysInYear(2024)===366&&P.daysInYear(2026)===365);
// parse/validate
ok('parse bad',P.parseISO('2026-02-30')===null&&P.parseISO('x')===null&&P.parseISO('2026-13-01')===null);
ok('addDays month',P.addDays('2026-10-31',1)==='2026-11-01'&&P.addDays('2024-02-28',1)==='2024-02-29'&&P.addDays('2026-01-01',-1)==='2025-12-31');
// week: Sunday start. 2026-10-11 is Sunday
ok('dow',P.dayOfWeek('2026-10-11')===0);
ok('weekKey sun',P.weekKey('2026-10-11')==='2026-10-11'&&P.weekKey('2026-10-17')==='2026-10-11'&&P.weekKey('2026-10-18')==='2026-10-18'&&P.weekKey('2026-10-10')==='2026-10-04');
ok('weekKey cross month',P.weekKey('2026-11-01')==='2026-11-01'&&P.weekKey('2026-10-31')==='2026-10-25');
// ranges: completed month counts all calendar days
let r=P.rangeOf({mode:'month',month:2,year:2024},'2026-10-11');
ok('feb24 range',r.from==='2024-02-01'&&r.to==='2024-02-29'&&r.days===29&&r.elapsed===29&&!r.partial);
r=P.rangeOf({mode:'month',month:2,year:2026},'2026-10-11');ok('feb26',r.days===28&&r.elapsed===28);
// current month: elapsed until today
r=P.rangeOf({mode:'month',month:10,year:2026},'2026-10-11');ok('cur month',r.days===31&&r.elapsed===11&&r.partial);
// year: leap and non leap, current year elapsed
r=P.rangeOf({mode:'year',year:2024},'2026-10-11');ok('year 2024',r.days===366&&r.elapsed===366);
r=P.rangeOf({mode:'year',year:2025},'2026-10-11');ok('year 2025',r.days===365&&r.elapsed===365);
r=P.rangeOf({mode:'year',year:2026},'2026-10-11');ok('year 2026 partial',r.days===365&&r.elapsed===284&&r.partial);
// future month
r=P.rangeOf({mode:'month',month:12,year:2026},'2026-10-11');ok('future',r.elapsed===0);
// custom inclusive
r=P.rangeOf({mode:'custom',from:'2026-09-01',to:'2026-09-30'},'2026-10-11');ok('custom incl',r.days===30&&r.from==='2026-09-01'&&r.to==='2026-09-30');
r=P.rangeOf({mode:'custom',from:'2026-09-05',to:'2026-09-05'},'2026-10-11');ok('custom one day',r.days===1);
// validation
ok('val reversed',P.validateFilter({mode:'custom',from:'2026-09-30',to:'2026-09-01'})!=='');
ok('val empty',P.validateFilter({mode:'custom',from:'',to:''})!=='');
ok('val ok',P.validateFilter({mode:'custom',from:'2026-09-01',to:'2026-09-01'})===''&&P.validateFilter({mode:'month',month:5,year:2026})===''&&P.validateFilter({mode:'year',year:2026})==='');
// summarize: average divides by all days incl. empty ones
const inc=[{date:'2026-09-01',amount:100},{date:'2026-09-15',amount:200},{date:'2026-09-15',amount:'50'},{date:'2026-08-31',amount:999},{date:'2026-10-01',amount:999},{date:'2026-09-30',amount:'x'}];
r=P.rangeOf({mode:'month',month:9,year:2026},'2026-10-11');
let s=P.summarize(inc,r);ok('sum sep',s.total===350&&s.count===4&&Math.abs(s.avgDaily-350/30)<1e-9);
// boundaries inclusive
const b=[{date:'2026-09-01',amount:1},{date:'2026-09-30',amount:2}];
ok('boundary incl',P.summarize(b,r).total===3);
// groupByDay order desc + weekly breaks
const g=P.groupByDay(inc,r);ok('group desc',g.map(x=>x.date).join()==='2026-09-30,2026-09-15,2026-09-01');
ok('group total',g.find(x=>x.date==='2026-09-15').total===250);
const wb=P.markWeekBreaks(P.groupByDay([{date:'2026-10-11',amount:1},{date:'2026-10-10',amount:1},{date:'2026-10-09',amount:1},{date:'2026-10-04',amount:1},{date:'2026-09-28',amount:1}],P.rangeOf({mode:'custom',from:'2026-09-01',to:'2026-10-31'})));
// weeks: 10-11 (Sun) | 10-04..10-10 | 09-27..10-03
ok('week breaks',wb.map(x=>x.weekBreakBefore).join()==='false,true,false,false,true');
ok('no break first',wb[0].weekBreakBefore===false);
// debts: original / paid / remaining separate, no double count
const debts=[{date:'2026-09-02',amount:1000,paidAmount:0,remainingAmount:1000,status:'unpaid',type:'receivable'},{date:'2026-09-03',amount:500,paidAmount:200,remainingAmount:300,status:'partial',type:'payable'},{date:'2026-09-04',amount:400,paidAmount:400,remainingAmount:0,status:'paid',type:'receivable'},{date:'2026-08-31',amount:777,paidAmount:0,remainingAmount:777,status:'unpaid',type:'receivable'}];
let d=P.debtSummary(debts,r);
ok('debt totals',d.count===3&&d.original===1900&&d.paid===600&&d.remaining===1300&&d.original-d.paid===d.remaining);
ok('debt status',d.byStatus.unpaid===1&&d.byStatus.partial===1&&d.byStatus.paid===1);
ok('debt dir',d.byDir.receivable.count===2&&d.byDir.receivable.original===1400&&d.byDir.payable.original===500);
d=P.debtSummary(debts,r,{dir:'receivable',status:'paid'});ok('debt filters',d.count===1&&d.original===400);
// payments: only confirmed in total; original debt not used
const pays=[{date:'2026-09-10',amount:200,status:'confirmed'},{date:'2026-09-11',amount:50,status:'pending'},{date:'2026-09-12',amount:70,status:'rejected'},{date:'2026-10-01',amount:999,status:'confirmed'}];
const ps=P.paymentSummary(pays,r);ok('payments',ps.total===200&&ps.count===1&&ps.pending===1&&ps.rejected===1);
console.log(`periods.js: ${pass} passed, ${fail} failed`);
