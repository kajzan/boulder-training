/* Tests für app.js – Aufruf: node tests/run.js */
const { install, group, check, eq, done } = require('./harness');

const { el } = install();

// ═══════════════════════════════════════════════
group('Escaping');
// ═══════════════════════════════════════════════
eq('esc() deckt alle fünf Sonderzeichen ab', esc(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
eq('esc() vertraegt null', esc(null), '');

// ═══════════════════════════════════════════════
group('Zyklus kopieren');
// ═══════════════════════════════════════════════
el('newCycleName').value = 'Quelle';
el('newCycleDate').value = '2026-01-05';
el('newCycleWeeks').value = '4';
el('copyFromCycle').value = '';
createCycle();

const src = getActiveCycle();
src.exercises.push({ id: 'a', name: 'Kilterboard', categories: ['Klettern'], intensity: 3 });
src.exercises.push({ id: 'b', name: 'Hangboard', categories: ['Finger'], intensity: 2 });
src.weekTargets = [9, 10, 11, 8];
saveData();

el('newCycleName').value = 'Kopie';
el('copyFromCycle').value = src.id;
createCycle();
const copy = getActiveCycle();

eq('Kategorien werden mitkopiert', copy.exercises.map(e => e.categories), [['Klettern'], ['Finger']]);
eq('Wochenziele werden mitkopiert', copy.weekTargets, [9, 10, 11, 8]);
check('Uebungen bekommen neue IDs', copy.exercises.every(e => !['a', 'b'].includes(e.id)));

// ═══════════════════════════════════════════════
group('Intensitaetsrechnung (Regression)');
// ═══════════════════════════════════════════════
const day0 = getWeekDates(copy, 0)[0];
copy.sessions[day0] = [{ exId: copy.exercises[0].id }];
eq('Wochenintensitaet aus Standardwert', getWeekIntensity(copy, 0), 3);
copy.sessions[day0][0].overrideInt = 5;
eq('Override sticht Standardwert', getWeekIntensity(copy, 0), 5);
eq('±1 gilt als erreicht', intensityClass(9, 9), 'int-green-dark');
eq('mehr als +1 gilt als ueberschritten', intensityClass(12, 9), 'int-red');

// ═══════════════════════════════════════════════
group('Assessment – Werte lesen und schreiben');
// ═══════════════════════════════════════════════
const tNum   = { kind: 'number', unit: 'kg', higherIsBetter: true, usesBodyweight: true };
const tTime  = { kind: 'time', higherIsBetter: true };
const tPace  = { kind: 'time', higherIsBetter: false };
const tCm    = { kind: 'number', unit: 'cm', higherIsBetter: false };
const tFont  = { kind: 'scale', scaleId: 'font', higherIsBetter: true };
const tGym   = { kind: 'scale', scaleId: 'gym', higherIsBetter: true };

eq('Komma wird als Dezimaltrenner akzeptiert', parseTestValue(tNum, '22,5'), 22.5);
eq('Punkt ebenso', parseTestValue(tNum, '22.5'), 22.5);
eq('negative Werte sind erlaubt', parseTestValue(tCm, '-5'), -5);
eq('leere Eingabe ergibt null', parseTestValue(tNum, '  '), null);
eq('Zeit als mm:ss', parseTestValue(tTime, '1:30'), 90);
eq('Zeit als reine Sekunden', parseTestValue(tTime, '12,5'), 12.5);
eq('Skalenwert ist der Index', parseTestValue(tFont, '9'), 9);

eq('Zahl mit Einheit', formatTestValue(tNum, 22.5), '22,5 kg');
eq('Sekunden unter einer Minute', formatTestValue(tTime, 12.5), '12,5 s');
eq('Sekunden ab einer Minute', formatTestValue(tTime, 90), '1:30');
eq('Sekundenrundung kippt nicht auf :60', formatTestValue(tTime, 119.6), '2:00');
eq('negative Zeit behaelt das Vorzeichen', formatTestValue(tTime, -5), '-5 s');
eq('Skala zeigt den Grad', formatTestValue(tFont, 9), '7A');
eq('Hallenskala zaehlt ab 1', formatTestValue(tGym, 6), '7');

// ═══════════════════════════════════════════════
group('Assessment – Fortschritt');
// ═══════════════════════════════════════════════
// Der Kernfall: +18 kg auf +22 kg sind NICHT "+22 %". Bezogen auf die
// Gesamtlast (Koerpergewicht + Zusatz) sind es +3,3 %.
const bwCmp = compareMeasurements(tNum,
  { value: 18, bodyweight: 72 },
  { value: 22, bodyweight: 71 });
eq('absolute Steigerung', bwCmp.absText, '+4 kg');
eq('Prozent auf der Gesamtlast statt auf dem Zusatzgewicht', bwCmp.pctText, '+3,33 %');
eq('Basis wird benannt', bwCmp.pctBasis, 'Gesamtlast');
check('Verhaeltnis zum Koerpergewicht wird gezeigt', bwCmp.detail === '1,25× KG → 1,31× KG', bwCmp.detail);
check('als Verbesserung gewertet', bwCmp.better === true);

// Ohne Koerpergewichtsbezug wird schlicht auf dem Wert gerechnet
const plain = compareMeasurements({ kind: 'number', unit: 'Wdh.', higherIsBetter: true, usesBodyweight: false },
  { value: 10, bodyweight: 0 }, { value: 12, bodyweight: 0 });
eq('Prozent ohne KG-Bezug', plain.pctText, '+20 %');

// "weniger ist besser": Finger-Boden-Abstand von 10 cm auf -2 cm
const flex = compareMeasurements(tCm, { value: 10, bodyweight: 0 }, { value: -2, bodyweight: 0 });
eq('Verschlechterung im Vorzeichen sichtbar', flex.absText, '-12 cm');
check('Rueckgang zaehlt hier als Verbesserung', flex.better === true);

// Pace: 5:00 min/km auf 4:30 min/km ist besser, obwohl der Wert faellt
const pace = compareMeasurements(tPace, { value: 300, bodyweight: 0 }, { value: 270, bodyweight: 0 });
eq('Pace-Differenz als Zeit', pace.absText, '-30 s');
check('schnellere Pace zaehlt als Verbesserung', pace.better === true);

// Skalen zaehlen in Graden und liefern bewusst KEINEN Prozentwert
const grade = compareMeasurements(tFont, { value: 6, bodyweight: 0 }, { value: 9, bodyweight: 0 });
eq('Skalensprung in Graden', grade.absText, '+3 Grade');
eq('Skala nennt Start und Ziel', grade.detail, '6B+ → 7A');
check('kein Prozentwert bei Skalen', grade.pctText === undefined);
const oneGrade = compareMeasurements(tFont, { value: 6, bodyweight: 0 }, { value: 7, bodyweight: 0 });
eq('Einzahl bei einem Grad', oneGrade.absText, '+1 Grad');

// Gleichstand ist weder gut noch schlecht
const same = compareMeasurements(tNum, { value: 20, bodyweight: 70 }, { value: 20, bodyweight: 70 });
check('Gleichstand wird nicht gewertet', same.better === null);

// ═══════════════════════════════════════════════
group('Assessment – Speichern und Verlauf');
// ═══════════════════════════════════════════════
el('testName').value = 'Max Hang 20 mm';
el('testKind').value = 'number';
el('testUnit').value = 'kg';
el('testCat').value = 'Finger';
el('testHigher').dataset.on = '1';
el('testBw').dataset.on = '1';
saveTest(null);
const hang = appData.tests[0];
check('Test wurde angelegt', !!hang && hang.name === 'Max Hang 20 mm');
check('Koerpergewichtsbezug gespeichert', hang.usesBodyweight === true);
eq('Kategorie verknuepft', hang.category, 'Finger');

el('assDate').value = '2026-03-31';
el('assLabel').value = 'Nach Zyklus 1';
el('assCycle').value = copy.id;
el('assBw').value = '72';
el('res_' + hang.id).value = '18';
saveAssessment(null);

el('assDate').value = '2026-06-30';
el('assLabel').value = 'Nach Zyklus 2';
el('assBw').value = '71';
el('res_' + hang.id).value = '22';
saveAssessment(null);

const series = getTestSeries(hang.id);
eq('beide Messpunkte vorhanden', series.map(p => p.value), [18, 22]);
eq('chronologisch sortiert', series.map(p => p.date), ['2026-03-31', '2026-06-30']);
eq('Koerpergewicht je Messtag mitgefuehrt', series.map(p => p.bodyweight), [72, 71]);

// Leere Felder duerfen keinen Nullwert erzeugen
el('assDate').value = '2026-09-30';
el('assLabel').value = 'Leer';
el('res_' + hang.id).value = '';
saveAssessment(null);
eq('leer gelassene Messung legt keinen Wert an', getTestSeries(hang.id).length, 2);

// ═══════════════════════════════════════════════
group('Loeschen');
// ═══════════════════════════════════════════════
const nBefore = appData.assessments.length;
deleteAssessment(appData.assessments[nBefore - 1].id);
eq('Messung wird entfernt', appData.assessments.length, nBefore - 1);
deleteAssessment('gibtsnicht');
eq('unbekannte ID richtet nichts an', appData.assessments.length, nBefore - 1);

// Der Loeschknopf gehoert in die Zeile, nicht nur ans Ende des Dialogs: der
// Dialog ist laenger als der Bildschirm, sein Knopf steht hinter "Speichern"
// und ist damit praktisch unauffindbar.
renderAssessment();
const listHtml = el('assessmentContent').innerHTML;
eq('Loeschknopf in jeder Messungszeile',
  (listHtml.match(/deleteAssessment\(/g) || []).length, appData.assessments.length);
eq('Loeschknopf in jeder Testzeile',
  (listHtml.match(/deleteTest\(/g) || []).length, appData.tests.length);
check('Loeschen oeffnet nicht zugleich den Bearbeiten-Dialog',
  listHtml.includes('event.stopPropagation(); deleteAssessment') &&
  listHtml.includes('event.stopPropagation(); deleteTest'));

// Einen Zwischenstand loeschen muss genauso gehen wie jede andere Messung
appData.assessments.push({ id: 'zw', date: '2026-05-15', label: 'Woche 6',
                           cycleId: null, bodyweight: 0, results: [] });
const nWithExtra = appData.assessments.length;
deleteAssessment('zw');
eq('Messung mitten im Zyklus laesst sich loeschen', appData.assessments.length, nWithExtra - 1);
check('und ist danach wirklich weg', !appData.assessments.some(a => a.id === 'zw'));

// ═══════════════════════════════════════════════
group('Assessment – Uebergang in den naechsten Zyklus');
// ═══════════════════════════════════════════════
// Tests liegen bewusst auf oberster Ebene statt im Zyklus. Damit gelten sie
// automatisch auch im naechsten Zyklus, und die Messhistorie ueberlebt selbst
// das Loeschen eines Zyklus.
const testsBefore = appData.tests.map(t => t.id);
const historyBefore = getTestSeries(hang.id).length;

el('newCycleName').value = 'Folgezyklus';
el('newCycleWeeks').value = '4';
el('copyFromCycle').value = copy.id;
createCycle();

eq('Tests gelten im neuen Zyklus unveraendert weiter',
  appData.tests.map(t => t.id), testsBefore);
eq('Messhistorie bleibt vollstaendig', getTestSeries(hang.id).length, historyBefore);
check('der neue Zyklus ist aktiv', getActiveCycle().name === 'Folgezyklus');
check('eine neue Messung laesst sich dem neuen Zyklus zuordnen',
  appData.cycles.some(c => c.id === getActiveCycle().id));

// Auch das Loeschen eines Zyklus darf die Benchmark-Historie nicht anfassen
const doomed = getActiveCycle().id;
deleteCycle(doomed);
eq('Messhistorie ueberlebt das Loeschen eines Zyklus',
  getTestSeries(hang.id).length, historyBefore);
check('Tests ueberleben das Loeschen ebenfalls', appData.tests.length === testsBefore.length);

// ═══════════════════════════════════════════════
group('Assessment – Migration');
// ═══════════════════════════════════════════════
delete appData.tests;
delete appData.assessments;
migrateAssessments();
check('fehlende Listen werden ergaenzt',
  Array.isArray(appData.tests) && Array.isArray(appData.assessments));

appData.tests = [{ id: 'alt', name: 'Altbestand' }];
migrateAssessments();
const alt = appData.tests[0];
check('Test ohne Art bekommt Standardwerte',
  alt.kind === 'number' && alt.higherIsBetter === true &&
  alt.usesBodyweight === false && alt.category === '' && alt.unit === '');

// ═══════════════════════════════════════════════
group('Render-Pfade ueberleben Sonderzeichen');
// ═══════════════════════════════════════════════
const NASTY = 'Klimm<b>zug</b> & "Co"';
appData.tests = [{ id: 't1', name: NASTY, kind: 'number', unit: 'kg',
                   category: NASTY, higherIsBetter: true, usesBodyweight: false }];
appData.assessments = [{ id: 'a1', date: '2026-05-01', label: NASTY, cycleId: copy.id,
                         bodyweight: 70, results: [{ testId: 't1', value: 5 }] }];
const cyc = getActiveCycle();
cyc.name = NASTY;
cyc.exercises = [{ id: 'x1', name: NASTY, categories: [NASTY], intensity: 2 }];
cyc.sessions[getWeekDates(cyc, 0)[0]] = [{ exId: 'x1' }];
saveData();

function clean(label, html) {
  const leaked = html.includes('<b>zug</b>');
  const escaped = html.includes('Klimm&lt;b&gt;');
  check(label, !leaked && escaped, leaked ? 'rohes HTML durchgerutscht' : 'nichts Escapetes gefunden');
}

renderPlan();       clean('renderPlan',       el('planContent').innerHTML);
renderDashboard();  clean('renderDashboard',  el('dashContent').innerHTML);
renderHistory();    clean('renderHistory',    el('historyContent').innerHTML);
renderSettings();   clean('renderSettings',   el('settingsContent').innerHTML);
renderAssessment(); clean('renderAssessment', el('assessmentContent').innerHTML);

openTestProgressModal('t1');   clean('openTestProgressModal', el('modalContent').innerHTML);
openAssessmentModal('a1');     clean('openAssessmentModal',   el('modalContent').innerHTML);
openTestModal('t1');           clean('openTestModal',         el('modalContent').innerHTML);
openCycleDetail(cyc.id);       clean('openCycleDetail',       el('modalContent').innerHTML);
openWeekModal(0);              clean('openWeekModal',         el('modalContent').innerHTML);
clean('buildDayModalContent', buildDayModalContent(getWeekDates(cyc, 0)[0]));

// ═══════════════════════════════════════════════
group('Erinnerung am Zyklusende');
// ═══════════════════════════════════════════════
eq('Zyklusende richtig berechnet',
  getCycleEndDate({ startDate: '2026-01-05', weeks: 4 }), '2026-02-01');

appData.assessments = [];
const today = new Date();
const endsIn3 = new Date(today); endsIn3.setDate(endsIn3.getDate() + 3 - 4 * 7 + 1);
cyc.startDate = toDateStr(endsIn3);
cyc.weeks = 4;
check('meldet sich in der letzten Woche', getAssessmentReminder() !== null);

appData.assessments = [];
const endsIn30 = new Date(today); endsIn30.setDate(endsIn30.getDate() + 30 - 4 * 7 + 1);
cyc.startDate = toDateStr(endsIn30);
check('schweigt, solange der Zyklus laeuft', getAssessmentReminder() === null);

// Eine fruehe Messung im Zyklus loest die Erinnerung am Ende nicht ab,
// eine Messung im Zeitfenster der letzten Woche schon.
cyc.startDate = toDateStr(endsIn3);
const cycEnd = getCycleEndDate(cyc);
const frueh = new Date(parseDate(cycEnd)); frueh.setDate(frueh.getDate() - 20);
appData.assessments = [{ id: 'z', date: toDateStr(frueh), cycleId: cyc.id, results: [] }];
check('fruehe Messung loest die Erinnerung nicht ab', getAssessmentReminder() !== null);

const spaet = new Date(parseDate(cycEnd)); spaet.setDate(spaet.getDate() - 2);
appData.assessments = [{ id: 'z', date: toDateStr(spaet), cycleId: cyc.id, results: [] }];
check('Messung in der letzten Woche loest sie ab', getAssessmentReminder() === null);

// Auch ohne Zyklusbezug zaehlt sie – der Zeitpunkt entscheidet, nicht die Zuordnung
appData.assessments = [{ id: 'z', date: toDateStr(spaet), cycleId: null, results: [] }];
check('Zuordnung zum Zyklus ist dafuer nicht noetig', getAssessmentReminder() === null);

// Ohne Tests soll die Erinnerung trotzdem kommen, aber woanders hinfuehren
appData.assessments = [];
const savedTests = appData.tests;
appData.tests = [];
const noTests = getAssessmentReminder();
check('erinnert auch ohne angelegte Tests', noTests !== null);
check('und weist auf das Anlegen hin', noTests && noTests.needsTests === true);
appData.tests = savedTests;
check('mit Tests kein Hinweis aufs Anlegen', getAssessmentReminder().needsTests === false);

// ═══════════════════════════════════════════════
group('Routenzaehlung nach Grad');
// ═══════════════════════════════════════════════
const tCounts = { kind: 'counts', scaleId: 'gym', higherIsBetter: true };
// Hallenskala: Index 6 = "7", Index 7 = "8", Index 8 = "9"
eq('Gesamtzahl der Routen', countsTotal({ 6: 12, 7: 5, 8: 1 }), 18);
eq('leere Zaehlung ergibt null Routen', countsTotal({}), 0);
eq('Aufschluesselung lesbar', formatTestValue(tCounts, { 6: 12, 7: 5, 8: 1 }), '12× 7 · 5× 8 · 1× 9');
eq('Nullwerte tauchen nicht auf', formatTestValue(tCounts, { 6: 3, 7: 0 }), '3× 7');
eq('gar nichts erfasst', formatTestValue(tCounts, {}), '–');
eq('Aufschluesselung ist nach Grad sortiert',
  formatTestValue(tCounts, { 8: 1, 6: 12 }), '12× 7 · 1× 9');

const cCmp = compareMeasurements(tCounts, { value: { 6: 12, 7: 5 } }, { value: { 6: 14, 7: 6, 8: 1 } });
eq('Zuwachs in Routen', cCmp.absText, '+4 Routen');
eq('Gesamtzahlen benannt', cCmp.detail, '17 → 21 Routen gesamt');
eq('Prozent auf der Gesamtzahl', cCmp.pctText, '+23,53 %');
const oneRoute = compareMeasurements(tCounts, { value: { 6: 1 } }, { value: { 6: 2 } });
eq('Einzahl bei einer Route', oneRoute.absText, '+1 Route');
check('Rueckgang wird als solcher gewertet',
  compareMeasurements(tCounts, { value: { 6: 5 } }, { value: { 6: 3 } }).better === false);

// ═══════════════════════════════════════════════
group('Trainingsvolumen gegen Leistung');
// ═══════════════════════════════════════════════
const volCycle = getDefaultCycle('Volumen-Zyklus', 2);
volCycle.exercises = [
  { id: 'f1', name: 'Hangboard', categories: ['Finger'], intensity: 3 },
  { id: 'k1', name: 'Klettern', categories: ['Basis'], intensity: 2 }
];
const vDays = getWeekDates(volCycle, 0);
volCycle.sessions[vDays[0]] = [{ exId: 'f1' }, { exId: 'k1' }];
volCycle.sessions[vDays[1]] = [{ exId: 'f1' }];
// Volumen wird ueber Zeitraeume gerechnet, nicht ueber Zyklen: eine Messung
// ist ein freier Zeitpunkt, der Zeitraum ergibt sich aus zwei Messungen.
appData.cycles = [volCycle];
appData.assessments = [];
const d0 = vDays[0], d1 = vDays[1];
eq('Volumen je Kategorie im Zeitraum',
  getCategoryVolume(null, d1), { Finger: 6, Basis: 2 });
eq('Startdatum ist exklusiv – der erste Tag faellt raus',
  getCategoryVolume(d0, d1), { Finger: 3 });
eq('Enddatum ist inklusive', getCategoryVolume(null, d0), { Finger: 3, Basis: 2 });
eq('Zeitraum vor jedem Training ist leer', getCategoryVolume(null, '2020-01-01'), {});

eq('einzelne Kategorie', getCategoryVolumeFor(null, d1, 'Finger'), 6);
eq('Schreibweise egal', getCategoryVolumeFor(null, d1, '  fInGeR '), 6);
eq('unbekannte Kategorie ergibt null', getCategoryVolumeFor(null, d1, 'Ausdauer'), 0);
eq('leere Kategorie ergibt null', getCategoryVolumeFor(null, d1, ''), 0);

// Ein Zeitraum darf ueber Zyklusgrenzen laufen
const cycA = getDefaultCycle('A', 1); cycA.startDate = '2026-01-05';
cycA.exercises = [{ id: 'e1', name: 'Hang', categories: ['Finger'], intensity: 4 }];
cycA.sessions['2026-01-06'] = [{ exId: 'e1' }];
const cycB = getDefaultCycle('B', 1); cycB.startDate = '2026-01-12';
cycB.exercises = [{ id: 'e2', name: 'Hang', categories: ['Finger'], intensity: 5 }];
cycB.sessions['2026-01-13'] = [{ exId: 'e2' }];
appData.cycles = [cycA, cycB];
eq('Zeitraum zaehlt ueber Zyklusgrenzen hinweg',
  getCategoryVolumeFor('2026-01-01', '2026-01-20', 'Finger'), 9);
eq('und laesst sich auf einen Zyklus eingrenzen',
  getCategoryVolumeFor('2026-01-01', '2026-01-10', 'Finger'), 4);

// Die vorherige Messung bestimmt den Beginn des Zeitraums
appData.assessments = [
  { id: 'm1', date: '2026-01-01', label: 'Start', cycleId: null, results: [] },
  { id: 'm2', date: '2026-02-01', label: 'Mitte', cycleId: null, results: [] },
  { id: 'm3', date: '2026-03-01', label: 'Ende', cycleId: null, results: [] }
];
eq('vorherige Messung gefunden', getPreviousAssessment('2026-03-01').id, 'm2');
eq('vor der ersten gibt es keine', getPreviousAssessment('2026-01-01'), null);
eq('sich selbst ignoriert man dabei',
  getPreviousAssessment('2026-02-01', 'm2').id, 'm1');
eq('Tage zwischen zwei Messungen', daysBetween('2026-01-01', '2026-02-01'), 31);
eq('Zyklus zu einem Datum gefunden', findCycleForDate('2026-01-06').name, 'A');
eq('ausserhalb aller Zyklen kein Treffer', findCycleForDate('2026-06-01'), null);

// ═══════════════════════════════════════════════
group('Verlaufsdiagramm');
// ═══════════════════════════════════════════════
const chartTest = { id: 'ct', name: 'Chart', kind: 'number', unit: 'kg',
                    higherIsBetter: true, usesBodyweight: false, category: '' };
eq('kein Diagramm bei einem einzelnen Punkt',
  renderTestChart(chartTest, [{ date: '2026-01-01', value: 5 }]), '');
const chartSvg = renderTestChart(chartTest, [
  { date: '2026-01-01', value: 5 },
  { date: '2026-02-01', value: 8 },
  { date: '2026-06-01', value: 9 }
]);
check('Diagramm enthaelt eine Linie', chartSvg.includes('<path'));
check('Diagramm enthaelt drei Punkte', (chartSvg.match(/<circle/g) || []).length === 3);
check('Start- und Enddatum beschriftet',
  chartSvg.includes('1.1.') && chartSvg.includes('1.6.'), chartSvg.slice(0, 100));

// X-Achse ist zeitproportional: der Punkt nach einem Monat muss deutlich
// linker liegen als die Mitte, weil danach vier Monate Pause folgen.
const xs = [...chartSvg.matchAll(/<circle cx="([\d.]+)"/g)].map(m => parseFloat(m[1]));
check('X-Achse bildet echte Zeitabstaende ab',
  xs[1] - xs[0] < (xs[2] - xs[0]) / 2, JSON.stringify(xs));

// Skalentests beschriften die Y-Achse mit Graden statt mit Zahlen
const scaleSvg = renderTestChart({ kind: 'scale', scaleId: 'font', higherIsBetter: true },
  [{ date: '2026-01-01', value: 6 }, { date: '2026-03-01', value: 9 }]);
check('Y-Achse zeigt bei Skalen Grade', scaleSvg.includes('6B') || scaleSvg.includes('7A'),
  scaleSvg.slice(0, 300));

// Zaehltests werden ueber ihre Gesamtzahl gezeichnet
const countSvg = renderTestChart(tCounts, [
  { date: '2026-01-01', value: { 6: 5 } },
  { date: '2026-03-01', value: { 6: 8, 7: 2 } }
]);
check('Zaehltests lassen sich zeichnen', countSvg.includes('<path'));

// ═══════════════════════════════════════════════
group('Mehrere Kategorien pro Uebung');
// ═══════════════════════════════════════════════
// Migration: der alte Einzelwert wird zur Liste
const oldCycle = getDefaultCycle('Alt', 2);
oldCycle.id = 'cyc-alt';
oldCycle.exercises = [
  { id: 'o1', name: 'Hangboard', category: 'Finger', intensity: 3 },
  { id: 'o2', name: 'Ohne Kategorie', category: '', intensity: 1 }
];
appData.cycles = [oldCycle];
appData.activeCycleId = oldCycle.id;
migrateCycles();
eq('Einzelkategorie wird zur Liste', oldCycle.exercises[0].categories, ['Finger']);
eq('leere Kategorie wird zur leeren Liste', oldCycle.exercises[1].categories, []);
check('das alte Feld ist danach weg', oldCycle.exercises.every(e => e.category === undefined));

// Textfeld lesen und schreiben
eq('Komma trennt', parseCategories('Pull, Finger'), ['Pull', 'Finger']);
eq('Leerraum wird getrimmt', parseCategories('  Pull ,  Finger  '), ['Pull', 'Finger']);
eq('leere Teile fallen weg', parseCategories('Pull,,Finger,'), ['Pull', 'Finger']);
eq('Duplikate fallen weg, Schreibweise egal', parseCategories('Pull, pull'), ['Pull']);
eq('leerer Text ergibt leere Liste', parseCategories('   '), []);
eq('und wieder zurueck in Text', formatCategories(['Pull', 'Finger']), 'Pull, Finger');

eq('doppelte Kategorien werden zusammengefasst',
  exerciseCategories({ categories: ['Pull', ' pull ', 'Finger'] }), ['Pull', 'Finger']);
eq('ohne Liste bleibt es leer', exerciseCategories({}), []);
eq('fuer die Verrechnung faellt Leeres auf Sonstige',
  exerciseCategoryKeys({ categories: [] }), ['Sonstige']);

// Aufteilung der Intensitaet
const multiCycle = getDefaultCycle('Multi', 2);
multiCycle.id = 'cyc-multi';
multiCycle.exercises = [
  { id: 'c1', name: 'Campus Board', categories: ['Pull', 'Finger'], intensity: 3 },
  { id: 'c2', name: 'Hangboard', categories: ['Finger'], intensity: 2 },
  { id: 'c3', name: 'Dehnen', categories: [], intensity: 1 }
];
const md = getWeekDates(multiCycle, 0);
multiCycle.sessions[md[0]] = [{ exId: 'c1' }, { exId: 'c2' }, { exId: 'c3' }];
appData.cycles = [multiCycle];
appData.activeCycleId = multiCycle.id;

const bd = getWeekCategoryBreakdown(multiCycle, 0);
eq('Campus Board zaehlt haelftig auf Pull', bd.Pull, 1.5);
eq('haelftig auf Finger, dazu das ganze Hangboard', bd.Finger, 3.5);
eq('ohne Kategorie zaehlt es auf Sonstige', bd.Sonstige, 1);

// Die entscheidende Bedingung: die Aufteilung darf die Wochenintensitaet nicht
// aufblaehen, sonst waere das gestapelte Diagramm hoeher als der Wert, gegen
// den es sein Ziel vergleicht.
const summe = Object.keys(bd).reduce((s, k) => s + bd[k], 0);
eq('Aufteilung summiert sich genau auf die Wochenintensitaet',
  summe, getWeekIntensity(multiCycle, 0));

eq('alle Kategorien erfasst, Sonstige zuletzt',
  getAllCategoriesInCycle(multiCycle), ['Finger', 'Pull', 'Sonstige']);

// Auch das Volumen fuer die Assessments teilt auf
eq('Volumen teilt ebenso auf', getCategoryVolumeFor(null, md[0], 'Pull'), 1.5);
eq('und summiert dieselbe Kategorie ueber mehrere Uebungen',
  getCategoryVolumeFor(null, md[0], 'Finger'), 3.5);

// Ein Override wirkt auf beide Kategorien gleichermassen
multiCycle.sessions[md[0]][0].overrideInt = 5;
const bd2 = getWeekCategoryBreakdown(multiCycle, 0);
eq('Override wird ebenfalls aufgeteilt', bd2.Pull, 2.5);
multiCycle.sessions[md[0]][0].overrideInt = undefined;

// Kopieren muss die ganze Liste mitnehmen, und zwar als eigene Kopie
el('newCycleName').value = 'Multi-Kopie';
el('newCycleWeeks').value = '2';
el('copyFromCycle').value = multiCycle.id;
createCycle();
const mCopy = getActiveCycle();
eq('beide Kategorien mitkopiert', mCopy.exercises[0].categories, ['Pull', 'Finger']);
mCopy.exercises[0].categories.push('Extra');
eq('die Kopie teilt sich die Liste nicht mit dem Original',
  multiCycle.exercises[0].categories, ['Pull', 'Finger']);

// Darstellung
appData.activeCycleId = multiCycle.id;
renderPlan();
const planHtml = el('planContent').innerHTML;
check('beide Kategorien stehen in der Uebungsliste',
  planHtml.includes('Pull') && planHtml.includes('Finger'));
check('jede Kategorie bekommt einen eigenen Punkt',
  (planHtml.match(/●/g) || []).length >= 3, 'Punkte: ' + (planHtml.match(/●/g) || []).length);

// ═══════════════════════════════════════════════
group('Uebungen sortieren');
// ═══════════════════════════════════════════════
const sortCycle = getDefaultCycle('Sortieren', 2);
sortCycle.id = 'cyc-sort';
sortCycle.exercises = [
  { id: 's1', name: 'Erste', categories: [], intensity: 1 },
  { id: 's2', name: 'Zweite', categories: [], intensity: 2 },
  { id: 's3', name: 'Dritte', categories: [], intensity: 3 }
];
appData.cycles = [sortCycle];
appData.activeCycleId = sortCycle.id;

reorderExercises(['s3', 's1', 's2']);
eq('Reihenfolge folgt den uebergebenen IDs',
  sortCycle.exercises.map(e => e.id), ['s3', 's1', 's2']);
check('die Uebungen selbst bleiben unveraendert',
  sortCycle.exercises.find(e => e.id === 's3').name === 'Dritte');

// Fehlt eine ID, darf die Uebung nicht verschwinden
reorderExercises(['s2', 's1']);
eq('nicht genannte Uebungen wandern ans Ende und bleiben erhalten',
  sortCycle.exercises.map(e => e.id), ['s2', 's1', 's3']);

// Unbekannte IDs werden ignoriert
reorderExercises(['gibtsnicht', 's1', 's2', 's3']);
eq('unbekannte IDs werden uebergangen',
  sortCycle.exercises.map(e => e.id), ['s1', 's2', 's3']);
eq('und die Anzahl bleibt gleich', sortCycle.exercises.length, 3);

// Leere Liste laesst alles stehen
reorderExercises([]);
eq('leere Liste aendert nichts', sortCycle.exercises.map(e => e.id), ['s1', 's2', 's3']);

// Die Reihenfolge muss gespeichert sein, nicht nur im Arbeitsspeicher stehen
reorderExercises(['s3', 's2', 's1']);
const gespeichert = JSON.parse(localStorage.getItem('boulderApp_v2'));
eq('die neue Reihenfolge wird gespeichert',
  gespeichert.cycles.find(c => c.id === 'cyc-sort').exercises.map(e => e.id),
  ['s3', 's2', 's1']);

// Darstellung: eigener Container und ein Anfasser je Zeile
renderPlan();
const sortHtml = el('planContent').innerHTML;
check('Uebungen liegen in einem eigenen Container', sortHtml.includes('id="exerciseList"'));
eq('ein Anfasser je Uebung', (sortHtml.match(/class="drag-handle"/g) || []).length, 3);
eq('jede Zeile traegt ihre ID', (sortHtml.match(/data-exid=/g) || []).length, 3);
check('der Anfasser oeffnet nicht den Bearbeiten-Dialog',
  sortHtml.includes('onclick="event.stopPropagation()" title="Ziehen zum Sortieren"'));

done();
