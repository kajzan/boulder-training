/* Tests für app.js – Aufruf: node tests/run.js */
const { install, group, check, eq, done } = require('./harness');

const { el } = install();

// ═══════════════════════════════════════════════
group('Version');
eq('Versionsdatum lesbar', formatVersionDate('2026-10-08 19:05'), '8. Okt 2026, 19:05 Uhr');
check('version.js hat Nummer und Datum', /^\d+$/.test(APP_VERSION.name) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(APP_VERSION.date));

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

// ═══════════════════════════════════════════════
group('Abgleich-Modell: hin und zurueck');
// ═══════════════════════════════════════════════
const kopie = x => JSON.parse(JSON.stringify(x));
const gleich = (a, b) => syncCanon(a) === syncCanon(b);

// Vergleichsform: gleicht die Reihenfolgen an, die das Modell bewusst selbst
// festlegt (Zyklen, Tests, Messungen nach ID; abgehakte Uebungen eines Tages
// nach Trainingsplan), und entfernt leere Tage und das Altformat.
function vergleichsform(data) {
  const d = kopie(data);
  const nachId = (a, b) => syncCmp(a.id, b.id);
  d.cycles.sort(nachId);
  d.cycles.forEach(c => {
    const rang = new Map(c.exercises.map((ex, i) => [String(ex.id), i]));
    const rangVon = e => rang.has(String(e.exId)) ? rang.get(String(e.exId)) : c.exercises.length;
    const tage = {};
    Object.keys(c.sessions || {}).sort().forEach(datum => {
      const liste = (c.sessions[datum] || [])
        .map(e => typeof e === 'string' ? { exId: e } : e)
        .sort((a, b) => rangVon(a) - rangVon(b) || syncCmp(a.exId, b.exId));
      if (liste.length) tage[datum] = liste;
    });
    c.sessions = tage;
  });
  d.tests.sort(nachId);
  d.assessments.sort(nachId);
  d.ascents = (d.ascents || []).sort(nachId);
  return d;
}

const BESTAND = {
  activeCycleId: 'c2',
  cycles: [
    { id: 'c2', name: 'Sommer', startDate: '2026-06-01', weeks: 2, weekTargets: [8, 9], notes: {},
      zukunftsfeld: { von: 'einer spaeteren Version' },
      mode: 'plan', pauses: [{ from: '2026-06-03', to: '2026-06-05' }], pausedAt: '2026-06-20',
      exercises: [
        { id: 'e2', name: 'Campus', categories: ['Pull', 'Finger'], intensity: 3, days: [0, 4], desc: '3 Leitern' },
        { id: 'e1', name: 'Hangboard', categories: ['Finger'], intensity: 2, measure: true, unit: 'kg' },
        { id: 'e3', name: 'Dehnen', categories: [], intensity: 1 }
      ],
      sessions: {
        '2026-06-01': [{ exId: 'e1', value: -15, note: 'einarmig, Band' }, { exId: 'e2', overrideInt: 4.5 }],
        '2026-06-02': [],
        '2026-06-03': ['e3']
      } },
    { id: 'c1', name: 'Frühjahr', startDate: '2026-03-01', weeks: 1, weekTargets: [5], notes: {},
      exercises: [{ id: 'e1', name: 'Hangboard', categories: ['Finger'], intensity: 2 }],
      sessions: { '2026-03-02': [{ exId: 'e1' }] } }
  ],
  tests: [
    { id: 't2', name: 'Grad', kind: 'scale', scaleId: 'font', unit: '', category: '', higherIsBetter: true, usesBodyweight: false },
    { id: 't1', name: 'Max Hang', kind: 'number', unit: 'kg', category: 'Finger', higherIsBetter: true, usesBodyweight: true },
    { id: 't3', name: 'Routen', kind: 'counts', scaleId: 'gym', unit: '', category: '', higherIsBetter: true, usesBodyweight: false },
    { id: 't4', name: 'Pace', kind: 'time', unit: '', category: '', higherIsBetter: false, usesBodyweight: false }
  ],
  assessments: [
    { id: 'a2', date: '2026-06-30', label: 'Ende', cycleId: 'c2', bodyweight: 71,
      results: [{ testId: 't1', value: 22, note: 'gut' }, { testId: 't3', value: { 6: 12, 7: 5 } }] },
    { id: 'a1', date: '2026-03-31', label: '', cycleId: null, bodyweight: 0, results: [] }
  ],
  ascents: [
    { id: 'l2', date: '2027-01-03', scaleId: 'font', grade: 7, style: 'flash', place: 'halle' },
    { id: 'l1', date: '2026-12-30', scaleId: 'vscale', grade: 4, style: 'project', place: 'fels', name: 'Dachkante', note: 'fast' }
  ]
};

const bestandDocs = toDocs(BESTAND);
check('hin und zurueck geht nichts verloren',
  gleich(fromDocs(bestandDocs), vergleichsform(BESTAND)),
  JSON.stringify(fromDocs(bestandDocs)).slice(0, 300));
check('zurueck und wieder hin ergibt exakt dieselben Eintraege',
  gleich(toDocs(fromDocs(bestandDocs)), bestandDocs));

const schluessel = Object.keys(bestandDocs);
check('je Zyklus ein Eintrag', schluessel.includes('cycle:c1') && schluessel.includes('cycle:c2'));
check('gleiche Uebungs-ID in zwei Zyklen bleibt getrennt',
  schluessel.includes('exercise:c1:e1') && schluessel.includes('exercise:c2:e1'));
eq('jede abgehakte Uebung ist ein eigener Eintrag',
  schluessel.filter(k => k.startsWith('entry:')).sort(),
  ['entry:c1:2026-03-02:e1', 'entry:c2:2026-06-01:e1', 'entry:c2:2026-06-01:e2', 'entry:c2:2026-06-03:e3']);
check('ein leerer Tag erzeugt keinen Eintrag',
  !schluessel.some(k => k.includes('2026-06-02')));
eq('das alte Format abgehakter Uebungen wird mit uebernommen',
  bestandDocs['entry:c2:2026-06-03:e3'], { exId: 'e3', cycleId: 'c2', date: '2026-06-03' });
eq('eine geaenderte Intensitaet reist mit',
  (bestandDocs['entry:c2:2026-06-01:e2'] || {}).overrideInt, 4.5);
eq('Messwert und Notiz beim Abhaken reisen mit',
  [bestandDocs['entry:c2:2026-06-01:e1'].value, bestandDocs['entry:c2:2026-06-01:e1'].note], [-15, 'einarmig, Band']);
eq('Logbuch-Eintraege tragen ihr Jahr im Schluessel',
  schluessel.filter(k => k.startsWith('ascent:')).sort(), ['ascent:2026:l1', 'ascent:2027:l2']);
eq('Logbuch liegt je Jahr in einem eigenen Dokument',
  [storageGroup('ascent:2026:l1'), storageGroup('ascent:2027:l2')], ['a~2026', 'a~2027']);
check('Logbuch-Dokumente gelten als Ablage, nicht als Altbestand',
  isStorageGroup('a~2026') && flattenStorage({ 'a~2026': { k: { 'ascent:2026:l1': { id: 'l1' } } } }).legacy.length === 0);
eq('Pausen, Wochenplan und Trainingstage reisen mit',
  [bestandDocs['cycle:c2'].mode, bestandDocs['cycle:c2'].pauses, bestandDocs['cycle:c2'].pausedAt,
   bestandDocs['exercise:c2:e2'].days],
  ['plan', [{ from: '2026-06-03', to: '2026-06-05' }], '2026-06-20', [0, 4]]);

const zurueck = fromDocs(bestandDocs);
eq('Zyklen nach Anlegezeitpunkt geordnet', zurueck.cycles.map(c => c.id), ['c1', 'c2']);
eq('die Reihenfolge der Uebungen bleibt erhalten',
  zurueck.cycles[1].exercises.map(e => e.id), ['e2', 'e1', 'e3']);
eq('unbekannte Felder einer spaeteren Version ueberleben',
  zurueck.cycles[1].zukunftsfeld, { von: 'einer spaeteren Version' });
eq('Zaehlwerte einer Messung bleiben erhalten',
  zurueck.assessments[1].results[1].value, { 6: 12, 7: 5 });
check('die Uebungen tragen keine Hilfsfelder ins App-Modell',
  zurueck.cycles.every(c => c.exerciseOrder === undefined &&
    c.exercises.every(ex => ex.cycleId === undefined)));

// Die Eintraege muessen vom App-Objekt geloest sein
const losgeloest = kopie(BESTAND);
const losDocs = toDocs(losgeloest);
losgeloest.cycles[0].exercises[0].name = 'nachtraeglich geaendert';
eq('spaetere Aenderungen am App-Objekt veraendern die Eintraege nicht',
  losDocs['exercise:c2:e2'].name, 'Campus');

// Firestore nimmt nicht alles: kein undefined, kein Array direkt in einem
// Array, keine '/' in IDs, keine reservierten Namen, hoechstens 1500 Bytes.
function firestoreProbleme(docs) {
  const probleme = [];
  const pruefe = (v, pfad, imArray) => {
    if (v === undefined) probleme.push(pfad + ': undefined');
    else if (Array.isArray(v)) {
      if (imArray) probleme.push(pfad + ': Array direkt in Array');
      v.forEach((x, i) => pruefe(x, pfad + '[' + i + ']', true));
    } else if (v && typeof v === 'object') {
      Object.keys(v).forEach(k => pruefe(v[k], pfad + '.' + k, false));
    } else if (typeof v === 'number' && !isFinite(v)) probleme.push(pfad + ': ' + v);
  };
  Object.keys(docs).forEach(k => {
    if (k.includes('/')) probleme.push(k + ': enthaelt /');
    if (/^__.*__$/.test(k)) probleme.push(k + ': reservierter Name');
    if (Buffer.byteLength(k) > 1500) probleme.push(k + ': zu lang');
    pruefe(docs[k], k, false);
  });
  return probleme;
}
eq('alle Eintraege sind fuer Firestore zulaessig', firestoreProbleme(bestandDocs), []);

// IDs aus eingelesenen Altdaten koennen Trennzeichen enthalten
const sonder = toDocs({ activeCycleId: null, tests: [], assessments: [], cycles: [
  { id: 'a:b', name: 'x', exercises: [{ id: 'c', name: 'x', categories: [], intensity: 1 }], sessions: {} },
  { id: 'a', name: 'y', exercises: [{ id: 'b:c', name: 'y', categories: [], intensity: 1 }], sessions: {} },
  { id: 'mit/strich', name: 'z', exercises: [], sessions: {} }
] });
eq('Trennzeichen in IDs vermischen keine Schluessel',
  Object.keys(sonder).filter(k => k.startsWith('exercise:')).length, 2);
eq('ein / in einer ID landet nicht im Schluessel', firestoreProbleme(sonder), []);
eq('und kommt unveraendert zurueck',
  fromDocs(sonder).cycles.map(c => c.id).sort(), ['a', 'a:b', 'mit/strich']);

// ═══════════════════════════════════════════════
group('Abgleich-Modell: Aenderungen erkennen');
// ═══════════════════════════════════════════════
check('ohne Aenderung nichts zu tun', isEmptyDiff(diffDocs(bestandDocs, toDocs(BESTAND))));

const umsortierteFelder = {};
Object.keys(bestandDocs).forEach(k => {
  const d = bestandDocs[k], neu = {};
  Object.keys(d).reverse().forEach(f => { neu[f] = d[f]; });
  umsortierteFelder[k] = neu;
});
check('andere Feldreihenfolge ist keine Aenderung',
  isEmptyDiff(diffDocs(bestandDocs, umsortierteFelder)));

const umbenannt = kopie(BESTAND);
umbenannt.cycles[1].exercises[0].name = 'Hangboard 20 mm';
const dUmbenannt = diffDocs(bestandDocs, toDocs(umbenannt));
eq('eine Umbenennung aendert genau einen Eintrag', Object.keys(dUmbenannt.set), ['exercise:c1:e1']);
eq('und loescht nichts', dUmbenannt.del, []);

const ohneTest = kopie(BESTAND);
ohneTest.tests = ohneTest.tests.filter(t => t.id !== 't4');
eq('Loeschen wird als Loeschen erkannt', diffDocs(bestandDocs, toDocs(ohneTest)).del, ['test:t4']);

const mitFremdem = Object.assign({ 'zukunft:x': { neu: true } }, bestandDocs);
check('Eintraege unbekannter Art werden nie geloescht',
  !diffDocs(mitFremdem, toDocs(fromDocs(mitFremdem))).del.includes('zukunft:x'));

// ═══════════════════════════════════════════════
group('Abgleich-Modell: zwei Geraete');
// ═══════════════════════════════════════════════
// Beide Geraete starten vom selben Stand und aendern offline. Danach landen
// beide Aenderungen auf dem gemeinsamen Stand, B als zweites.
function zweiGeraete(start, aendereA, aendereB, aZuletzt) {
  const basis = toDocs(start);
  const a = kopie(start); aendereA(a);
  const b = kopie(start); aendereB(b);
  const dA = diffDocs(basis, toDocs(a));
  const dB = diffDocs(basis, toDocs(b));
  const server = aZuletzt ? applyDiff(applyDiff(basis, dB), dA) : applyDiff(applyDiff(basis, dA), dB);
  return { daten: fromDocs(server), server };
}

const START = {
  activeCycleId: 'c1', tests: [], assessments: [],
  cycles: [{ id: 'c1', name: 'Zyklus', startDate: '2026-09-07', weeks: 4, weekTargets: [8, 8, 8, 8], notes: {},
    exercises: [
      { id: 'x1', name: 'Hangboard', categories: ['Finger'], intensity: 2 },
      { id: 'x2', name: 'Klimmzüge', categories: ['Pull'], intensity: 2 },
      { id: 'x3', name: 'Campus', categories: ['Pull', 'Finger'], intensity: 3 }
    ],
    sessions: { '2026-09-07': [{ exId: 'x1' }] } }]
};
const zy = d => d.cycles[0];
const abhaken = (d, datum, exId) => {
  const s = zy(d).sessions;
  if (!s[datum]) s[datum] = [];
  s[datum].push({ exId });
};
const uebungLoeschen = (d, exId) => {
  zy(d).exercises = zy(d).exercises.filter(e => e.id !== exId);
  Object.keys(zy(d).sessions).forEach(t => {
    zy(d).sessions[t] = zy(d).sessions[t].filter(e => e.exId !== exId);
  });
};
const abgehakt = (d, datum) => (zy(d).sessions[datum] || []).map(e => e.exId);

let r = zweiGeraete(START,
  d => abhaken(d, '2026-09-08', 'x2'),
  d => zy(d).exercises.push({ id: 'x4', name: 'Laufen', categories: ['Ausdauer'], intensity: 2 }));
check('Handy hakt ab, Laptop legt Uebung an: beides bleibt',
  abgehakt(r.daten, '2026-09-08').includes('x2') && zy(r.daten).exercises.some(e => e.id === 'x4'));

r = zweiGeraete(START,
  d => abhaken(d, '2026-09-08', 'x2'),
  d => abhaken(d, '2026-09-08', 'x3'));
eq('am selben Tag Verschiedenes abgehakt: beide Haken bleiben',
  abgehakt(r.daten, '2026-09-08'), ['x2', 'x3']);

r = zweiGeraete(START,
  d => { zy(d).sessions['2026-09-07'][0].overrideInt = 5; },
  d => abhaken(d, '2026-09-07', 'x2'));
check('geaenderte Intensitaet und neuer Haken am selben Tag: beides bleibt',
  zy(r.daten).sessions['2026-09-07'].find(e => e.exId === 'x1').overrideInt === 5 &&
  abgehakt(r.daten, '2026-09-07').includes('x2'));

r = zweiGeraete(START,
  d => uebungLoeschen(d, 'x2'),
  d => { zy(d).name = 'Herbst'; });
check('Handy loescht Uebung, Laptop benennt Zyklus um: Uebung bleibt geloescht',
  !zy(r.daten).exercises.some(e => e.id === 'x2'),
  JSON.stringify(zy(r.daten).exercises.map(e => e.id)));
eq('und die Umbenennung kommt an', zy(r.daten).name, 'Herbst');

r = zweiGeraete(START,
  d => uebungLoeschen(d, 'x2'),
  d => abhaken(d, '2026-09-09', 'x1'));
check('Geloeschtes kommt nicht zurueck, wenn das andere Geraet etwas anderes aendert',
  !zy(r.daten).exercises.some(e => e.id === 'x2') && abgehakt(r.daten, '2026-09-09').includes('x1'));

r = zweiGeraete(START,
  d => { zy(d).exercises[0].name = 'Hang 20 mm'; },
  d => { zy(d).exercises[0].name = 'Hang 15 mm'; });
eq('beide aendern dieselbe Uebung: die spaetere Aenderung gewinnt',
  zy(r.daten).exercises[0].name, 'Hang 15 mm');

// Umsortieren und Anlegen treffen beide die Reihenfolge am Zyklus. Welche
// Reihenfolge gilt, haengt davon ab, wer zuletzt schreibt - aber in keinem
// Fall darf dabei eine Uebung verloren gehen.
const umsortieren = d => { zy(d).exercises = [zy(d).exercises[2], zy(d).exercises[0], zy(d).exercises[1]]; };
const anlegen = d => zy(d).exercises.push({ id: 'x4', name: 'Laufen', categories: [], intensity: 2 });
const alleDa = d => ['x1', 'x2', 'x3', 'x4'].every(id => zy(d).exercises.some(e => e.id === id));
check('Umsortieren gegen Anlegen, Anlegen zuletzt: keine Uebung geht verloren',
  alleDa(zweiGeraete(START, umsortieren, anlegen, false).daten));
const umsortiertZuletzt = zweiGeraete(START, umsortieren, anlegen, true).daten;
check('Umsortieren gegen Anlegen, Umsortieren zuletzt: keine Uebung geht verloren',
  alleDa(umsortiertZuletzt));
eq('und die neue Uebung landet hinten', zy(umsortiertZuletzt).exercises.map(e => e.id),
  ['x3', 'x1', 'x2', 'x4']);

// Ein Geraet loescht den Zyklus, das andere hakt darin offline noch etwas ab.
// Der Haken hat danach keinen Zyklus mehr und wird beim naechsten Abgleich
// aufgeraeumt, statt den Zyklus halb zurueckzuholen.
r = zweiGeraete(START,
  d => { d.cycles = []; d.activeCycleId = null; },
  d => abhaken(d, '2026-09-10', 'x1'));
eq('geloeschter Zyklus bleibt geloescht', r.daten.cycles.length, 0);
const aufraeumen = diffDocs(r.server, toDocs(r.daten));
check('verwaiste Eintraege werden beim naechsten Abgleich entfernt',
  aufraeumen.del.includes('entry:c1:2026-09-10:x1'), JSON.stringify(aufraeumen.del));
check('nach dem Aufraeumen bleibt nichts vom Zyklus uebrig',
  !Object.keys(applyDiff(r.server, aufraeumen)).some(k => /^(entry|exercise|cycle):/.test(k)));

r = zweiGeraete({ activeCycleId: null, cycles: [], tests: [
    { id: 't1', name: 'Max Hang', kind: 'number', unit: 'kg', category: 'Finger', higherIsBetter: true, usesBodyweight: true }
  ], assessments: [] },
  d => d.assessments.push({ id: 'm1', date: '2026-09-10', label: 'Woche 4', cycleId: null, bodyweight: 70,
                             results: [{ testId: 't1', value: 20 }] }),
  d => { d.tests[0].name = 'Max Hang 20 mm'; });
check('Messung auf dem Handy, Test umbenannt am Laptop: beides bleibt',
  r.daten.assessments.length === 1 && r.daten.tests[0].name === 'Max Hang 20 mm');

// ═══════════════════════════════════════════════
group('Abgleich planen');
// ═══════════════════════════════════════════════
const leer = toDocs({ activeCycleId: null, cycles: [], tests: [], assessments: [] });
check('frische App hat keine Trainingsdaten', !hasUserData(leer));
check('ein Zyklus zaehlt als Trainingsdaten', hasUserData(toDocs(START)));

// Erste Anmeldung mit leerem Konto: alles vom Geraet hochladen
let plan = planFirstLink(toDocs(START), {}, true);
check('leeres Konto uebernimmt den Stand des Geraets', gleich(plan.result, toDocs(START)));
eq('und schreibt alle Eintraege hoch',
  Object.keys(plan.push.set).sort(), Object.keys(toDocs(START)).sort());

// Neues Geraet ohne Daten meldet sich an: der Kontostand gilt, nichts schreiben
plan = planFirstLink(leer, toDocs(START), true);
check('leeres Geraet bekommt den Kontostand', gleich(plan.result, toDocs(START)));
check('und schreibt dabei nichts', isEmptyDiff(plan.push));

// Beide haben Daten: zusammenfuehren oder nur Konto
const anderesGeraet = kopie(START);
anderesGeraet.cycles = [{ id: 'c9', name: 'Vom Laptop', startDate: '2026-08-01', weeks: 1,
  weekTargets: [3], notes: {}, exercises: [], sessions: {} }];
anderesGeraet.activeCycleId = 'c9';
plan = planFirstLink(toDocs(anderesGeraet), toDocs(START), true);
eq('zusammenfuehren behaelt beide Zyklen', fromDocs(plan.result).cycles.map(c => c.id), ['c1', 'c9']);
eq('und schreibt nur, was im Konto fehlt', Object.keys(plan.push.set), ['cycle:c9']);
eq('beim selben Eintrag gilt das Konto', fromDocs(plan.result).activeCycleId, 'c1');
eq('loescht beim Zusammenfuehren nichts', plan.push.del, []);
plan = planFirstLink(toDocs(anderesGeraet), toDocs(START), false);
check('ohne Zusammenfuehren gilt nur das Konto',
  gleich(plan.result, toDocs(START)) && isEmptyDiff(plan.push));

// Laufender Abgleich: eigene Aenderungen schreiben, fremde uebernehmen
const basisStand = toDocs(START);
const hier = kopie(START); abhaken(hier, '2026-09-08', 'x2');
const dort = kopie(START); zy(dort).name = 'Vom anderen Geraet';
plan = planSync(basisStand, toDocs(hier), toDocs(dort));
eq('nur die eigene Aenderung wird geschrieben', Object.keys(plan.push.set), ['entry:c1:2026-09-08:x2']);
check('die fremde Aenderung kommt an', zy(fromDocs(plan.result)).name === 'Vom anderen Geraet');
check('die eigene bleibt erhalten', abgehakt(fromDocs(plan.result), '2026-09-08').includes('x2'));

plan = planSync(basisStand, basisStand, toDocs(dort));
check('ohne eigene Aenderung wird nichts geschrieben', isEmptyDiff(plan.push));

// Offline geloescht, waehrenddessen anderswo umbenannt: das Loeschen bleibt
const geloescht = kopie(START); uebungLoeschen(geloescht, 'x2');
const umbenanntDort = kopie(START); zy(umbenanntDort).exercises[1].name = 'Klimmzüge eng';
plan = planSync(basisStand, toDocs(geloescht), toDocs(umbenanntDort));
check('offline geloeschte Uebung bleibt geloescht',
  !zy(fromDocs(plan.result)).exercises.some(e => e.id === 'x2'));

// ═══════════════════════════════════════════════
group('Ablage in Firestore');
// ═══════════════════════════════════════════════
// Bildet nach, wie Firestore die Schreibvorgaenge anwendet: Felder werden
// einzeln ersetzt oder entfernt, removeDoc loescht das ganze Dokument.
function speichere(ablage, writes, rawDeletes) {
  const neu = kopie(ablage);
  writes.forEach(w => {
    if (w.removeDoc) { delete neu[w.id]; return; }
    const d = neu[w.id] || { k: {} };
    Object.keys(w.set).forEach(k => { d.k[k] = kopie(w.set[k]); });
    w.del.forEach(k => { delete d.k[k]; });
    neu[w.id] = d;
  });
  (rawDeletes || []).forEach(id => { delete neu[id]; });
  return neu;
}

eq('Zyklus, Uebung und Haken liegen im Dokument ihres Zyklus',
  ['cycle:c1', 'exercise:c1:e1', 'entry:c1:2026-03-02:e1'].map(storageGroup), ['c~c1', 'c~c1', 'c~c1']);
eq('Tests, Messungen und Einstellungen liegen gemeinsam',
  ['test:t1', 'assessment:a1', 'settings:app'].map(storageGroup), ['misc', 'misc', 'misc']);

const ablage = speichere({}, storageWrites(diffDocs({}, bestandDocs), {}));
eq('ein Dokument je Zyklus und Logbuch-Jahr plus eines fuer den Rest', Object.keys(ablage).sort(), ['a~2026', 'a~2027', 'c~c1', 'c~c2', 'misc']);
check('auslesen ergibt dieselben Eintraege', gleich(flattenStorage(ablage).docs, bestandDocs));
eq('nichts Altes zu migrieren', flattenStorage(ablage).legacy, []);

// Ein Haken weg: nur dieses Feld, das Dokument bleibt
const ohneHaken = kopie(BESTAND);
ohneHaken.cycles[0].sessions['2026-06-01'] = [{ exId: 'e1' }];
const wHaken = storageWrites(diffDocs(bestandDocs, toDocs(ohneHaken)), bestandDocs);
eq('ein entfernter Haken betrifft genau ein Dokument', wHaken.map(w => w.id), ['c~c2']);
eq('und entfernt genau ein Feld', wHaken[0].del, ['entry:c2:2026-06-01:e2']);
check('das Dokument bleibt bestehen', !wHaken[0].removeDoc);

// Zyklus geloescht: das ganze Dokument geht
const ohneZyklus = kopie(BESTAND);
ohneZyklus.cycles = ohneZyklus.cycles.filter(c => c.id !== 'c1');
const wZyklus = storageWrites(diffDocs(bestandDocs, toDocs(ohneZyklus)), bestandDocs);
check('geloeschter Zyklus entfernt sein Dokument',
  wZyklus.some(w => w.id === 'c~c1' && w.removeDoc));
check('und laesst den Rest stehen', !wZyklus.some(w => w.id !== 'c~c1' && w.removeDoc));

// Zwei Geraete schreiben verschiedene Felder desselben Dokuments
const basisAblage = speichere({}, storageWrites(diffDocs({}, toDocs(START)), {}));
const handyDiff = diffDocs(toDocs(START), toDocs((() => { const d = kopie(START); abhaken(d, '2026-09-08', 'x2'); return d; })()));
const laptopDiff = diffDocs(toDocs(START), toDocs((() => { const d = kopie(START); abhaken(d, '2026-09-08', 'x3'); return d; })()));
const nachBeiden = speichere(speichere(basisAblage, storageWrites(handyDiff, toDocs(START))),
                             storageWrites(laptopDiff, toDocs(START)));
eq('beide Haken bleiben auch in der gebuendelten Ablage',
  abgehakt(fromDocs(flattenStorage(nachBeiden).docs), '2026-09-08'), ['x2', 'x3']);

// Umzug aus v7: dort lag jeder Eintrag als eigenes Dokument
const v7 = {};
Object.keys(bestandDocs).forEach(k => { v7[k] = bestandDocs[k]; });
let gelesen = flattenStorage(v7);
check('alte Einzeldokumente werden gelesen', gleich(gelesen.docs, bestandDocs));
eq('und zum Umzug gemeldet', gelesen.legacy.length, Object.keys(bestandDocs).length);

// Gemischter Stand waehrend des Umzugs: die gebuendelte Fassung gilt
const gemischt = Object.assign({}, ablage, { 'test:t1': Object.assign({}, bestandDocs['test:t1'], { name: 'alt' }) });
gelesen = flattenStorage(gemischt);
eq('bei doppeltem Eintrag gilt die gebuendelte Fassung', gelesen.docs['test:t1'].name, 'Max Hang');
eq('der alte Eintrag wird trotzdem zum Aufraeumen gemeldet', gelesen.legacy, ['test:t1']);

// Umzug ausgefuehrt wie in cloud.js
const umzug = storageWrites({ set: Object.assign({}, bestandDocs), del: [] }, bestandDocs);
const nachUmzug = speichere(v7, umzug, Object.keys(bestandDocs));
eq('nach dem Umzug nur noch gebuendelte Dokumente', Object.keys(nachUmzug).sort(), ['a~2026', 'a~2027', 'c~c1', 'c~c2', 'misc']);
check('und kein Eintrag ging verloren', gleich(flattenStorage(nachUmzug).docs, bestandDocs));

// ═══════════════════════════════════════════════
group('Abgleich-Modell: echte App-Daten');
// ═══════════════════════════════════════════════
// Daten, wie die App sie selbst erzeugt - nicht von Hand gebaut. IDs beruhen
// auf Date.now(); damit zwei schnelle Aufrufe im Test nicht dieselbe ID
// bekommen, laeuft die Uhr hier je Aufruf eine Millisekunde weiter.
const echteUhr = Date.now;
let uhr = echteUhr();
Date.now = () => ++uhr;
try {
  appData.cycles = []; appData.tests = []; appData.assessments = []; appData.activeCycleId = null;

  el('newCycleName').value = 'Echt';
  el('newCycleDate').value = '2026-09-07';
  el('newCycleWeeks').value = '4';
  el('copyFromCycle').value = '';
  createCycle();

  [['Campus', 'Pull, Finger', '3'], ['Hangboard', 'Finger', '2'], ['Dehnen', '', '1']].forEach(([n, k, i]) => {
    el('newExName').value = n; el('newExCat').value = k; el('newExInt').value = i;
    addExercise();
  });
  const echt = getActiveCycle();
  toggleDayEx('2026-09-07', echt.exercises[0].id);
  toggleDayEx('2026-09-07', echt.exercises[1].id);
  setOverride('2026-09-07', echt.exercises[0].id, '4');
  toggleDayEx('2026-09-08', echt.exercises[2].id);
  toggleDayEx('2026-09-08', echt.exercises[2].id);   // wieder abgehakt: leerer Tag bleibt zurueck

  el('testName').value = 'Routen Halle';
  el('testKind').value = 'counts';
  el('testScale').value = 'gym';
  el('testCat').value = '';
  el('testHigher').dataset.on = '1';
  el('testBw').dataset.on = '0';
  saveTest(null);
  const routen = appData.tests[appData.tests.length - 1];

  // Ein Zahlen-Test hat kein Skalenfeld; saveTest setzt es auf undefined.
  el('testName').value = 'Max Hang';
  el('testKind').value = 'number';
  el('testUnit').value = 'kg';
  el('testCat').value = 'Finger';
  el('testBw').dataset.on = '1';
  saveTest(null);
  check('Ausgangslage: der Zahlen-Test traegt ein undefined-Feld',
    Object.prototype.hasOwnProperty.call(appData.tests[appData.tests.length - 1], 'scaleId') &&
    appData.tests[appData.tests.length - 1].scaleId === undefined);
  el('assDate').value = '2026-09-10';
  el('assLabel').value = 'Woche 1';
  el('assCycle').value = echt.id;
  el('assBw').value = '';
  testScale(routen).steps.forEach((s, i) => { el(`res_${routen.id}_${i}`).value = i === 6 ? '12' : ''; });
  saveAssessment(null);

  const echtDocs = toDocs(appData);
  check('App-Daten ueberstehen hin und zurueck',
    gleich(fromDocs(echtDocs), vergleichsform(appData)));
  eq('App-Daten sind fuer Firestore zulaessig', firestoreProbleme(echtDocs), []);
  check('der Test ohne Skalenfeld hinterlaesst kein undefined',
    Object.values(echtDocs).every(d => !syncCanon(d).includes('undefined')));
} finally {
  Date.now = echteUhr;
}

// ═══════════════════════════════════════════════
// Heute festlegen: Die Pausenlogik rechnet mit dem aktuellen Datum.
const EchtesDate = Date;
function heuteIst(str) {
  const fest = new EchtesDate(str + 'T12:00:00').getTime();
  globalThis.Date = class extends EchtesDate {
    constructor(...a) { if (a.length) super(...a); else super(fest); }
    static now() { return fest; }
  };
}
function neuerZyklus(extra) {
  const c = Object.assign({ id: 'p' + Math.random().toString(36).slice(2, 7), name: 'P', startDate: '2026-01-05',
    weeks: 4, weekTargets: [1, 2, 3, 4], exercises: [{ id: 'x', name: 'Klimmzug max', categories: [], intensity: 1 }],
    sessions: {}, notes: {} }, extra || {});
  appData.cycles.push(c);
  appData.activeCycleId = c.id;
  return c;
}

try {
group('Zyklus pausieren');
heuteIst('2026-01-21');   // Mittwoch, Trainingstag 17 (Woche 3, Tag 3) ab Start Mo 05.01.
let pz = neuerZyklus();
eq('ohne Pause: dritte Woche', getCurrentWeekIndex(pz), 2);
pauseCycle();
eq('ohne Training heute: Pause beginnt heute', pz.pausedAt, '2026-01-21');
check('der Zyklus gilt als pausiert', isCyclePaused(pz));
eq('weiter geht es mit Woche 3, Tag 3', trainingPosition(pz), { week: 2, day: 2 });
heuteIst('2026-01-24');   // drei Tage später, Pause läuft (21.–24. = 4 Tage)
eq('laufende Pause: Woche 3 nimmt die Tage vor und nach der Pause',
  getWeekDates(pz, 2), ['2026-01-19', '2026-01-20', '2026-01-25', '2026-01-26', '2026-01-27', '2026-01-28', '2026-01-29']);
heuteIst('2026-01-25');   // nach vier Tagen Pause fortsetzen
resumeCycle();
eq('genau die vier Tage sind festgeschrieben', pz.pauses, [{ from: '2026-01-21', to: '2026-01-24' }]);
check('keine laufende Pause mehr', !isCyclePaused(pz) && pz.pausedAt === undefined);
eq('heute ist wieder Woche 3, Tag 3', trainingPosition(pz), { week: 2, day: 2 });
eq('alles danach rückt um genau 4 Tage', getWeekDates(pz, 3)[0], '2026-01-30');
eq('das Ende verschiebt sich um 4 Tage', getCycleEndDate(pz), '2026-02-05');
eq('die ersten Wochen bleiben, wo sie waren', getWeekDates(pz, 1), ['2026-01-12', '2026-01-13', '2026-01-14', '2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18']);
renderDashboard();
check('Übersicht zeigt die Pausentage bei der Woche', el('dashContent').innerHTML.includes('4 Tage Pause'));

heuteIst('2026-01-21');
pz = neuerZyklus();
pz.sessions['2026-01-21'] = [{ exId: 'x' }];
pauseCycle();
eq('heute schon trainiert: Pause beginnt morgen', pz.pausedAt, '2026-01-22');
check('trotzdem sofort pausiert', isCyclePaused(pz));
toggleDayEx('2026-01-22', 'x');
check('ab dem Pausentag wird nichts eingetragen', !pz.sessions['2026-01-22']);
check('der Tagesdialog bietet stattdessen Fortsetzen an', buildDayModalContent('2026-01-22').includes('resumeCycle()'));
toggleDayEx('2026-01-20', 'x');
check('vor der Pause darf nachgetragen werden', (pz.sessions['2026-01-20'] || []).length === 1);
renderDashboard();
check('Übersicht zeigt die Pause statt der Woche',
  el('dashContent').innerHTML.includes('Training pausiert') && el('dashContent').innerHTML.includes('Ab morgen') &&
  !el('dashContent').innerHTML.includes('Diese Trainingswoche'));
resumeCycle();
check('Fortsetzen vor Beginn hinterlässt keine Pause', pz.pausedAt === undefined && pz.pauses === undefined);

pz = neuerZyklus();
pauseCycle();
resumeCycle();
check('pausieren und am selben Tag fortsetzen: keine Pause', pz.pauses === undefined);

heuteIst('2026-01-21');
pz = neuerZyklus({ pausedAt: '2026-01-19' });
renderDashboard();
check('Übersicht zeigt die Pause mit Fortsetzen-Knopf und Dauer',
  el('dashContent').innerHTML.includes('resumeCycle()') && el('dashContent').innerHTML.includes('3 Tage'));

// Alte, wochenweise gespeicherte Pausen werden übernommen
const altPause = { cycles: [{ id: 'ap', name: 'A', startDate: '2026-01-05', weeks: 4, weekTargets: [], exercises: [],
  sessions: {}, notes: {}, pausedWeeks: [1], pausedSince: 3 }] };
normalizeData(altPause);
eq('alte Wochen-Pausen werden zu Tagen', [altPause.cycles[0].pauses, altPause.cycles[0].pausedAt,
  'pausedWeeks' in altPause.cycles[0], 'pausedSince' in altPause.cycles[0]],
  [[{ from: '2026-01-12', to: '2026-01-18' }], '2026-01-26', false, false]);

group('Wochenplan');
heuteIst('2026-01-21');   // Mittwoch
const wp = neuerZyklus({ mode: 'plan', exercises: [
  { id: 'a', name: 'Limit', categories: [], intensity: 3, days: [0] },
  { id: 'b', name: 'Volumen', categories: [], intensity: 2, days: [2], desc: '<b>viel</b>' },
  { id: 'c', name: 'Dehnen', categories: [], intensity: 1 }
] });
eq('Mittwoch geplant', plannedExercises(wp, '2026-01-21').map(e => e.id), ['b']);
eq('freier Modus plant nichts', plannedExercises(Object.assign({}, wp, { mode: undefined }), '2026-01-21'), []);
const tag = buildDayModalContent('2026-01-21');
check('Tagesdialog zeigt Geplantes zuerst', tag.indexOf('Volumen') < tag.indexOf('Limit') && tag.includes('Geplant'));
renderDashboard();
check('Heute-Karte nennt die geplante Übung', el('dashContent').innerHTML.includes('Heute · Mittwoch'));
check('Beschreibung wird maskiert', el('dashContent').innerHTML.includes('&lt;b&gt;viel'));
heuteIst('2026-01-22');
renderDashboard();
check('Ruhetag nennt den nächsten Trainingstag', el('dashContent').innerHTML.includes('Als Nächstes – Montag: Limit'));
togglePlanMode();
check('Wochenplan lässt sich ausschalten', !isPlanMode(wp) && wp.exercises[0].days.length === 1);
togglePlanMode();

const tpl = PLAN_TEMPLATES[1];
eq('Wochenziele der Vorlage im Rhythmus 3 + 1', templateTargets({ exercises: [{ intensity: 2, days: [0, 2] }] }, 5), [3.5, 4, 4.5, 2.5, 3.5]);
el('newCycleName').value = '';
el('newCycleDate').value = '2026-02-02';
el('newCycleWeeks').value = '12';
el('newCycleMode').value = 'plan';
el('copyFromCycle').value = 'tpl:' + tpl.id;
createCycle();
const ausVorlage = getActiveCycle();
check('Zyklus aus Vorlage ist im Wochenplan-Modus', ausVorlage.mode === 'plan');
eq('übernimmt den Vorlagennamen', ausVorlage.name, tpl.name.split(' · ')[0]);
eq('übernimmt alle Übungen mit Tagen', ausVorlage.exercises.map(e => e.days), tpl.exercises.map(e => e.days));
check('Übungen bekommen eigene IDs und Kopien',
  new Set(ausVorlage.exercises.map(e => e.id)).size === tpl.exercises.length &&
  ausVorlage.exercises[0].days !== tpl.exercises[0].days);
eq('Entlastungswoche ist leichter', ausVorlage.weekTargets[3] < ausVorlage.weekTargets[2], true);
check('alle Vorlagen haben gültige Tage und Intensitäten', PLAN_TEMPLATES.every(t =>
  t.exercises.every(e => e.days.length && e.days.every(d => d >= 0 && d <= 6) && e.intensity > 0)));

group('Messwert beim Abhaken');
heuteIst('2026-01-21');
const mz = neuerZyklus({ exercises: [{ id: 'm', name: 'Klimmzug max', categories: [], intensity: 1, measure: true, unit: 'kg' }] });
toggleDayEx('2026-01-19', 'm');
check('ohne Wert abhaken geht', mz.sessions['2026-01-19'].length === 1 && mz.sessions['2026-01-19'][0].value === undefined);
check('Eingabefelder erscheinen nach dem Abhaken', buildDayModalContent('2026-01-19').includes('setEntryValue'));
setEntryValue('2026-01-19', 'm', '12,5');
setEntryNote('2026-01-19', 'm', ' einarmig, Band ');
eq('Wert mit Komma und Notiz gespeichert', mz.sessions['2026-01-19'][0], { exId: 'm', value: 12.5, note: 'einarmig, Band' });
setEntryValue('2026-01-19', 'm', '');
check('leerer Wert entfernt den Wert', mz.sessions['2026-01-19'][0].value === undefined);
setEntryValue('2026-01-19', 'm', '15');
const hist = getExerciseMeasurements('klimmzug MAX');
check('Verlauf findet die Übung auch zyklusübergreifend über den Namen', hist.length >= 1 && hist[0].value === 15);
eq('Anzeige mit Einheit und Notiz', formatMeasure(mz.exercises[0], hist[0]), '15 kg · einarmig, Band');
check('ohne Messwert-Option keine Eingabefelder',
  !buildDayModalContent('2026-01-21').includes('setEntryValue'));

group('Übungsformular');
el('newExName').value = 'Max Hang'; el('newExCat').value = 'Finger'; el('newExInt').value = '2';
el('newExDesc').value = ''; el('newExUnit').value = 'kg'; el('newExMeasure').dataset.on = '1';
addExercise();
const neu = mz.exercises[mz.exercises.length - 1];
eq('Messwert-Option und Einheit gespeichert', [neu.measure, neu.unit], [true, 'kg']);
check('leere Beschreibung wird nicht gespeichert', !('desc' in neu));
el('editExName').value = 'Max Hang'; el('editExCat').value = ''; el('editExInt').value = '2';
el('editExDesc').value = '5 × 10 s'; el('editExUnit').value = 'kg'; el('editExMeasure').dataset.on = '0';
saveExerciseEdit(neu.id);
check('Messwert abwählen entfernt Einheit', !('measure' in neu) && !('unit' in neu) && neu.desc === '5 × 10 s');

group('Logbuch');
appData.ascents = [];
renderHistory();
check('leeres Logbuch erklärt sich', el('historyContent').innerHTML.includes('Grad-Pyramide'));
function eintragen(werte) {
  el('ascDate').value = werte.date; el('ascScale').value = werte.scaleId || 'font';
  el('ascGrade').value = String(werte.grade); el('ascStyle').dataset.val = werte.style;
  el('ascPlace').dataset.val = werte.place || 'halle';
  el('ascName').value = werte.name || ''; el('ascNote').value = '';
  saveAscent(werte.id || null);
}
eintragen({ date: '2026-01-19', grade: 7, style: 'flash' });            // 6C
eintragen({ date: '2026-01-19', grade: 7, style: 'top' });
eintragen({ date: '2026-01-20', grade: 9, style: 'top', name: '<Dach>' });   // 7A
eintragen({ date: '2026-01-21', grade: 11, style: 'project' });          // 7B
eq('drei Tops, ein Projekt', appData.ascents.length, 4);
eq('Pyramide ohne Projekte, höchster Grad oben',
  gradePyramid('font'), [{ grade: 9, flash: 0, top: 1 }, { grade: 7, flash: 1, top: 1 }]);
renderHistory();
const lb = el('historyContent').innerHTML;
check('Höchster Grad 7A, bester Flash 6C', lb.includes('>7A<') && lb.includes('>6C<'));
check('Namen werden maskiert', lb.includes('&lt;Dach&gt;') && !lb.includes('<Dach>'));
check('neuester Eintrag steht oben', lb.indexOf('7B') < lb.indexOf('&lt;Dach&gt;'));
const projekt = appData.ascents.find(a => a.style === 'project');
eintragen({ id: projekt.id, date: '2026-01-25', grade: 11, style: 'top' });
eq('Projekt geschafft: aus dem Projekt wird ein Top', gradePyramid('font')[0], { grade: 11, flash: 0, top: 1 });
deleteAscent(projekt.id);
eq('Löschen entfernt den Eintrag', appData.ascents.length, 3);
check('Logbuch reist durch den Abgleich', gleich(fromDocs(toDocs(appData)).ascents, kopie(appData.ascents).sort((a, b) => a.id < b.id ? -1 : 1)));
} finally {
  globalThis.Date = EchtesDate;
}


// ═══════════════════════════════════════════════
group('Sicherung wiederherstellen');
// ═══════════════════════════════════════════════
const vorher = kopie(appData);
const datei = normalizeData({ cycles: [
  { id: 'imp1', name: 'Aus Datei', startDate: '2025-01-06', weeks: 2, weekTargets: [1, 1],
    exercises: [{ id: 'q', name: 'Q', category: 'Alt', intensity: 1 }], sessions: { '2025-01-06': ['q'] }, notes: {} }
], activeCycleId: 'imp1' });
check('alte Sicherung wird beim Einlesen angepasst',
  Array.isArray(datei.tests) && Array.isArray(datei.ascents) && datei.cycles[0].exercises[0].categories[0] === 'Alt' &&
  typeof datei.cycles[0].sessions['2025-01-06'][0] === 'object');
check('Einlesen speichert nichts', JSON.stringify(appData) === JSON.stringify(vorher));
eq('Zusammenfassung', dataSummary(datei), '1 Zyklus · 1 Trainingstag · 0 Messungen · 0 Boulder');

openRestoreModal(datei, 'Datei test.json');
applyRestore('merge');
check('Hinzufügen behält alle bisherigen Zyklen', vorher.cycles.every(c => appData.cycles.some(x => x.id === c.id)));
check('Hinzufügen bringt den neuen Zyklus', appData.cycles.some(c => c.id === 'imp1'));
eq('Hinzufügen lässt den aktiven Zyklus', appData.activeCycleId, vorher.activeCycleId);
eq('Hinzufügen behält das Logbuch', appData.ascents.length, vorher.ascents.length);
check('der Stand davor ist gemerkt', !!getUndoInfo());
undoImport();
check('rückgängig: wieder genau der alte Stand', gleich(toDocs(appData), toDocs(vorher)));
check('rückgängig räumt den Merker weg', getUndoInfo() === null);

// Gleicher Eintrag in beiden: das Gerät gewinnt
const aufGeraet = { cycles: [{ id: 'g', name: 'Neu', startDate: '2026-01-05', weeks: 1, weekTargets: [1], notes: {},
  exercises: [{ id: 'a', name: 'A', categories: [], intensity: 2 }], sessions: { '2026-01-05': [{ exId: 'a' }] } }],
  activeCycleId: 'g', tests: [], assessments: [], ascents: [] };
const sicherung = { cycles: [{ id: 'g', name: 'Alt', startDate: '2026-01-05', weeks: 1, weekTargets: [1], notes: {},
  exercises: [{ id: 'a', name: 'A alt', categories: [], intensity: 1 }, { id: 'b', name: 'B', categories: [], intensity: 1 }],
  sessions: { '2026-01-06': [{ exId: 'b' }] } }], activeCycleId: 'g', tests: [], assessments: [],
  ascents: [{ id: 'l9', date: '2025-05-01', scaleId: 'font', grade: 3, style: 'top', place: 'fels' }] };
const zus = mergeData(aufGeraet, sicherung);
eq('bei Gleichem gilt das Gerät', [zus.cycles[0].name, zus.cycles[0].exercises[0].name], ['Neu', 'A']);
eq('Fehlendes kommt dazu', zus.cycles[0].exercises.map(e => e.id), ['a', 'b']);
eq('Haken beider Tage', Object.keys(zus.cycles[0].sessions).sort(), ['2026-01-05', '2026-01-06']);
eq('Logbuch aus der Sicherung', zus.ascents.length, 1);

openRestoreModal(normalizeData(kopie(sicherung)), 'x');
applyRestore('replace');
eq('Ersetzen: genau der Stand der Sicherung', appData.cycles.map(c => c.name), ['Alt']);
undoImport();
check('auch Ersetzen lässt sich zurücknehmen', gleich(toDocs(appData), toDocs(vorher)));

(async () => {
  // ═══════════════════════════════════════════════
  group('Pläne teilen');
  // ═══════════════════════════════════════════════
  const quelle = { name: 'Plan für Lisa', weeks: 3, weekTargets: [5, 6, 3, 99],
    exercises: [
      { id: 'x', name: 'Max Hang <b>', categories: ['Finger'], intensity: 2, days: [0, 3], desc: '5 × 10 s', measure: true, unit: 'kg' },
      { id: 'y', name: 'Bouldern', categories: [], intensity: 3 }
    ], sessions: { '2026-01-05': [{ exId: 'x', value: 20 }] } };
  const geteilt = planFromCycle(quelle, 'Trainer Max', 'Gut aufwärmen');
  check('keine Trainingsdaten im Plan', !JSON.stringify(geteilt).includes('2026-01-05') && !('sessions' in geteilt));
  eq('Wochenziele auf die Wochenzahl gekürzt', geteilt.weekTargets, [5, 6, 3]);
  const code = await encodePlan(geteilt);
  check('Code ist link-tauglich', /^[zj][A-Za-z0-9_-]+$/.test(code), code.slice(0, 20));
  check('komprimiert', code[0] === 'z');
  const zurueckPlan = await decodePlan(planLink(code));
  eq('hin und zurück über den Link', zurueckPlan, validatePlan(geteilt));
  eq('auch nur der Code geht', (await decodePlan(code)).name, 'Plan für Lisa');
  eq('unkomprimierter Code geht auch',
    (await decodePlan('j' + b64url(new TextEncoder().encode(JSON.stringify(geteilt))))).exercises.length, 2);

  let fehler = 0;
  for (const kaputt of ['', 'hallo', 'https://x.de/#plan=zzzz', 'j' + b64url(new TextEncoder().encode('{"exercises":[]}')),
                        'j' + b64url(new TextEncoder().encode('[1,2]'))]) {
    try { await decodePlan(kaputt); } catch (e) { fehler++; }
  }
  eq('kaputte Links werden abgelehnt', fehler, 5);

  const bereinigt = validatePlan({ name: 'x'.repeat(500), weeks: 999, weekTargets: ['a', -3, 4],
    exercises: [{ name: 'A', intensity: '5', days: [0, 9, 'x', 0], categories: ['k', 7], desc: 5, measure: 'ja', extra: 'weg' }, { intensity: 1 }],
    author: { boese: 1 }, sessions: { a: 1 } });
  eq('fremde Eingaben werden bereinigt', bereinigt, { v: 1, name: 'x'.repeat(80), unit: 'int', weeks: 52,
    weekTargets: [0, 0, 4].concat(Array(49).fill(0)),
    exercises: [{ name: 'A', categories: ['k'], intensity: 0, days: [0] }] });

  el('planStart').value = '2026-03-02';
  pendingPlan = zurueckPlan;
  startImportedPlan();
  const ausLink = getActiveCycle();
  eq('importierter Plan wird aktiver Zyklus', [ausLink.name, ausLink.startDate, ausLink.mode, ausLink.weeks], ['Plan für Lisa', '2026-03-02', 'plan', 3]);
  eq('Übungen mit Tagen und Beschreibung', ausLink.exercises.map(e => [e.name, e.days, e.desc, e.unit]),
    [['Max Hang <b>', [0, 3], '5 × 10 s', 'kg'], ['Bouldern', undefined, undefined, undefined]]);
  check('neue IDs', !ausLink.exercises.some(e => e.id === 'x' || e.id === 'y'));
  eq('Absender und Hinweis bleiben sichtbar', [ausLink.planAuthor, ausLink.planNote], ['Trainer Max', 'Gut aufwärmen']);
  currentView = 'plan';
  renderPlan();
  check('Trainingsplan zeigt Absender und maskiert Namen',
    el('planContent').innerHTML.includes('Plan von Trainer Max') && el('planContent').innerHTML.includes('Max Hang &lt;b&gt;'));

  // ═══════════════════════════════════════════════
  group('Einheiten: Intensität, Minuten, Stunden');
  // ═══════════════════════════════════════════════
  const mz2 = { id: 'u1', unit: 'min', name: 'Zeit', startDate: '2026-01-05', weeks: 2, weekTargets: [240, 180],
    exercises: [{ id: 'b', name: 'Bouldern', categories: [], intensity: 90, days: [0] }], sessions: {}, notes: {} };
  eq('Anzeige in Minuten', [fmtAmount(mz2, 90), fmtExAmount(mz2, 90)], ['90 min', '90 min']);
  eq('Anzeige in Stunden', fmtAmount({ unit: 'h' }, 1.5), '1,5 h');
  eq('Intensität ohne Einheit, Übung mit ×', [fmtAmount({}, 9.5), fmtExAmount({}, 3)], ['9,5', '×3']);
  eq('Toleranz je Einheit: 230 von 240 min gilt als erreicht', intensityClass(230, 240, unitInfo(mz2).tol), 'int-green-dark');
  eq('bei Intensität wären 10 Punkte daneben nur fast erreicht', intensityClass(230, 240), 'int-green-light');
  const tplF = PLAN_TEMPLATES[1];
  eq('Vorlage in Minuten', templateAmount(tplF.exercises[0], 'min'), tplF.exercises[0].minutes);
  eq('Vorlage in Stunden auf Viertelstunden gerundet', templateAmount({ minutes: 75 }, 'h'), 1.25);
  check('jede Vorlagen-Übung hat eine Dauer', PLAN_TEMPLATES.every(t => t.exercises.every(e => e.minutes > 0)));
  el('newCycleName').value = 'Zeit'; el('newCycleDate').value = '2026-03-02'; el('newCycleWeeks').value = '8';
  el('newCycleMode').value = 'plan'; el('copyFromCycle').value = 'tpl:' + tplF.id; el('newCycleUnit').dataset.val = 'min';
  createCycle();
  const zz = getActiveCycle();
  eq('neuer Zyklus zählt in Minuten', [zz.unit, zz.exercises[0].intensity], ['min', tplF.exercises[0].minutes]);
  check('Wochenziele in 5-Minuten-Schritten', zz.weekTargets.every(t => t % 5 === 0) && zz.weekTargets[0] > 100);
  el('newCycleName').value = 'Kopie'; el('copyFromCycle').value = zz.id; el('newCycleUnit').dataset.val = 'int';
  createCycle();
  eq('eine Kopie behält die Einheit des Originals', getActiveCycle().unit, 'min');
  const geteiltMin = await decodePlan(await encodePlan(planFromCycle(zz, '', '')));
  eq('geteilte Pläne nehmen die Einheit mit', geteiltMin.unit, 'min');
  currentView = 'dashboard';
  renderDashboard();
  check('Übersicht beschriftet mit Trainingszeit und Minuten',
    el('dashContent').innerHTML.includes('Trainingszeit (min)') && el('dashContent').innerHTML.includes('min Ziel'));
  el('newCycleUnit').dataset.val = '';

  // ═══════════════════════════════════════════════
  group('Sehr lange und sehr kurze Zyklen');
  // ═══════════════════════════════════════════════
  const lang = { id: 'L', name: 'Jahr', startDate: toDateStr(new Date()), weeks: 52, weekTargets: Array(52).fill(5),
    exercises: [], sessions: {}, notes: {} };
  appData.cycles.push(lang); appData.activeCycleId = 'L';
  showAllWeeks = false;
  renderDashboard();
  const html = el('dashContent').innerHTML;
  check('langes Diagramm passt in die Breite und lässt sich abtasten',
    !html.includes('chart-scroll') && html.includes('chartScrub') && html.includes('data-weeks="52"'));
  eq('Wochenliste zeigt nur die Umgebung', (html.match(/class="week-row /g) || []).length, 5);
  check('mit Knopf für alle Wochen', html.includes('Alle 52 Wochen anzeigen'));
  showAllWeeks = true;
  renderDashboard();
  eq('auf Wunsch alle 52', (el('dashContent').innerHTML.match(/class="week-row /g) || []).length, 52);
  showAllWeeks = false;
  lang.weekTargets = [9, 10, 11, 6].concat(Array(48).fill(0));
  repeatWeekTargets();
  eq('Muster der ersten 4 Wochen über das Jahr', [lang.weekTargets[4], lang.weekTargets[7], lang.weekTargets[51]], [9, 6, 6]);
  const kurz = { id: 'K', name: 'Kurz', startDate: toDateStr(new Date()), weeks: 1, weekTargets: [3],
    exercises: [], sessions: {}, notes: {} };
  appData.cycles.push(kurz); appData.activeCycleId = 'K';
  renderDashboard();
  const kh = el('dashContent').innerHTML;
  check('eine Woche: sinnvolle Überschrift', kh.includes('Die Woche') && !kh.includes('Alle 1 Wochen'));
  renderPlan();
  check('Wochenziele als Raster, ohne Übertragen-Knopf', el('planContent').innerHTML.includes('target-grid') &&
    !el('planContent').innerHTML.includes('repeatWeekTargets'));

  done();
})();
