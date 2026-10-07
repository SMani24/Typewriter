'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  book:'<path d="M12 5v15M3 4q5-1 9 2 4-3 9-2v15q-5-1-9 2-4-3-9-2Z"/>',
  chart:'<path d="M4 3v17h17M8 15v-4m5 4V7m5 8V4"/>',
  settings:'<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  arrow:'<path d="M4 12h15m-5-5 5 5-5 5"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
  spark:'<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5ZM20 2v4m-2-2h4"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  leaf:'<path d="M20 3C9 2 3 8 5 15s14 6 15-12ZM5 19 15 9"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  globe:'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
  upload:'<path d="M12 16V4m-4 4 4-4 4 4M4 16v5h16v-5"/>',
  edit:'<path d="m15 4 5 5M4 20l1-6L16 3l5 5-11 11ZM14 20h7"/>',
  volume:'<path d="M11 4 6 8H3v8h3l5 4ZM15 8q4 4 0 8m3-11q7 7 0 14"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.book}</svg>`;
function hydrateIcons(root = document) { $$('[data-icon]', root).forEach(el => el.innerHTML = icon(el.dataset.icon)); }
let state, currentPage = 'today', wordFilter = 'all', selected = new Set(), editingId = null, addMode = 'single', dictionaryData = null, dictionaryApplied = false, practice = null, deletingId = null, toastTimer;
const token = $('meta[name="typewriter-token"]').content;

async function api(path, method = 'GET', data) {
  const response = await fetch('/api' + path, {method, headers:{'Content-Type':'application/json','X-Typewriter-Token':token}, ...(data !== undefined ? {body:JSON.stringify(data)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Please try again.');
  return result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 8500 : 4500);
}
async function guarded(action, button) {
  if (button) button.disabled = true;
  try { return await action(); } catch (error) { toast(error.message || 'Please try again.', true); }
  finally { if (button) button.disabled = false; }
}
async function refresh() {
  state = await api('/state');
  selected = new Set([...selected].filter(id => state.words.some(w => w.id === id)));
  $('#loading').hidden = true;
  $('#app-content').hidden = false;
  render();
}
function navigate(page) {
  if (!['today','words','progress','settings'].includes(page)) page = 'today';
  currentPage = page;
  $$('.page').forEach(el => el.hidden = el.id !== 'page-' + page);
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  $('#page-title').textContent = ({today:'Today',words:'My words',progress:'Progress',settings:'Settings'})[page];
  if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  if (page === 'settings' && state) fillSettings();
  window.scrollTo({top:0,behavior:'instant'});
}
function badge(word) {
  const type = word.state.toLowerCase();
  return `<span class="badge ${type}">${escapeHtml(word.state)}</span>`;
}
function dueWords() {
  return state.words.filter(w => w.is_due).sort((a,b) => (a.accuracy ?? 50) - (b.accuracy ?? 50) || a.due.localeCompare(b.due));
}
function stat(label, value, note, symbol) {
  return `<div class="stat"><span class="stat-label">${label}</span><span class="icon-tile">${icon(symbol)}</span><div class="stat-value">${value}</div><span class="stat-note">${note}</span></div>`;
}
function empty(title, description, action = '', label = '') {
  return `<div class="empty-state"><div class="empty-icon">✳</div><h3>${title}</h3><p>${description}</p>${action ? `<button class="button secondary" data-action="${action}">${label}${icon('arrow')}</button>` : ''}</div>`;
}
function render() {
  const due = dueWords(), progress = state.progress;
  const accuracy = progress.reviews ? Math.round(100 * progress.correct / progress.reviews) + '%' : '—';
  const confident = state.words.filter(w => w.state === 'Confident').length;
  $('#nav-due').textContent = due.length;
  $('#today-stats').innerHTML = stat('Words ready for review', due.length, due.length ? 'A fresh chance to remember' : 'A little breathing room', 'sun') + stat('Your recall accuracy', accuracy, progress.reviews ? 'Across unaided reviews' : 'Your first review starts here', 'chart') + stat('Words growing familiar', confident, `Out of ${state.words.length} words in your notebook`, 'leaf');
  $('#hero-note').textContent = due.length ? `${Math.min(due.length,10)} words · A few focused minutes` : 'A few focused minutes · No need to rush';
  const next = (due.length ? due : state.words).slice(0,4);
  $('#next-words').innerHTML = next.length ? next.map(w => `<div class="next-word"><span class="word-initial">${escapeHtml(w.word[0])}</span><div><div class="next-word-name">${escapeHtml(w.word)}</div><div class="next-word-definition">${escapeHtml(w.definition || 'A word waiting for its story')}</div></div>${badge(w)}<button class="icon-button" data-drill="${w.id}" aria-label="Drill ${escapeHtml(w.word)}">${icon('arrow')}</button></div>`).join('') : empty('Start with a word you know.', 'Add a few words from your writing, or try our starter collection.', 'starter', 'Add starter words');
  renderLibrary();
  renderProgress();
  renderQueue();
  renderKeys();
}
function visibleWords() {
  const query = $('#word-search').value.toLowerCase().trim();
  return state.words.filter(w => (!query || [w.word,w.definition,w.tag].some(s => s.toLowerCase().includes(query))) && (wordFilter === 'all' || wordFilter === 'due' && w.is_due || wordFilter === 'learning' && ['New','Learning'].includes(w.state) || wordFilter === 'confident' && w.state === 'Confident' || wordFilter === 'pending' && w.status !== 'ready'));
}
function renderLibrary() {
  const words = visibleWords();
  $('#word-list').innerHTML = words.length ? words.map(w => `<div class="library-row"><div class="library-word"><input type="checkbox" data-select="${w.id}" aria-label="Select ${escapeHtml(w.word)}" ${selected.has(w.id) ? 'checked' : ''}><div><strong>${escapeHtml(w.word)} ${badge(w)}</strong><p title="${escapeHtml(w.definition || w.enrichment_error || 'Waiting for preparation')}">${escapeHtml(w.definition || (w.enrichment_error ? 'Preparation paused — try again or edit' : 'Waiting for a meaning'))}${w.tag ? ` · ${escapeHtml(w.tag)}` : ''}</p></div></div><div class="recall">${w.accuracy === null ? '—' : w.accuracy + '%'}<small>${w.reviews ? w.reviews + ' reviews' : 'Not reviewed'}</small></div><div class="due-date">${w.is_due ? '<strong>Ready today</strong>' : escapeHtml(new Date(w.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}))}</div><div class="library-actions"><button class="icon-button" data-drill="${w.id}" aria-label="Drill ${escapeHtml(w.word)}">${icon('keyboard')}</button><button class="icon-button" data-edit="${w.id}" aria-label="Edit ${escapeHtml(w.word)}">${icon('edit')}</button></div></div>`).join('') : empty(state.words.length ? 'No words here just yet.' : 'Every notebook begins somewhere.', state.words.length ? 'Try a different search or filter.' : 'Add words from your essays, reading, or everyday life.', state.words.length ? '' : 'add', 'Add your first words');
  $('#selection-bar').hidden = selected.size === 0;
  $('#selection-count').textContent = `${selected.size} word${selected.size === 1 ? '' : 's'} selected`;
  $('#select-all').checked = words.length > 0 && words.every(w => selected.has(w.id));
  $('#select-all').indeterminate = words.some(w => selected.has(w.id)) && !$('#select-all').checked;
}
function renderQueue() {
  const job = state.enrichment;
  $('#queue-banner').classList.toggle('busy', job.busy);
  $('#queue-banner').innerHTML = `${icon('spark')}<div><span>${job.busy ? escapeHtml(job.message) : job.pending ? `${job.pending} word${job.pending === 1 ? '' : 's'} waiting to be prepared` : 'Your words are ready when you are.'}</span><p>${job.busy ? 'You can keep practising while this runs.' : job.pending ? `Automatic preparation waits for ${state.settings.batch_size} words. Select a set or prepare the queue now.` : 'Meanings, sentences, and tips can always be edited.'}</p></div>${job.pending ? `<button class="text-button" data-action="prepare-all" ${job.busy ? 'disabled' : ''}>Prepare now${icon('arrow')}</button>` : ''}`;
  $('#settings-pending').textContent = job.busy ? job.message : `${job.pending} words queued`;
}
function renderProgress() {
  const p = state.progress;
  $('#progress-stats').innerHTML = stat('Unaided review attempts',p.reviews,'First answers, without revealed spelling','book') + stat('Correctly remembered',p.correct,'Progress you can build on','check') + stat('Drill repetitions',p.drills,'Focused practice, counted separately','keyboard');
  const days = Array.from({length:7},(_,i) => {const d = new Date(); d.setUTCDate(d.getUTCDate() - (6-i)); return d.toISOString().slice(0,10);});
  const maximum = Math.max(5,...p.history.map(d => d.total));
  $('#activity-chart').innerHTML = days.map(day => {const data = p.history.find(h => h.day === day) || {total:0,correct:0};return `<div class="chart-day"><span class="chart-value">${data.total || '·'}</span><div class="bar-track"><div class="bar-total" data-height="${Math.max(3,128 * data.total / maximum)}"><div class="bar-correct" data-height="${data.total ? 100 * data.correct / data.total : 0}" data-percent="true"></div></div></div><span>${new Date(day + 'T12:00:00Z').toLocaleDateString(undefined,{weekday:'short',timeZone:'UTC'})}</span></div>`;}).join('');
  $$('[data-height]','#activity-chart' instanceof Element ? '#activity-chart' : $('#activity-chart')).forEach(el => el.style.height = el.dataset.height + (el.dataset.percent ? '%' : 'px'));
  $('#mistake-list').innerHTML = p.mistakes.length ? p.mistakes.map(m => `<div class="mistake"><div><strong>${escapeHtml(m.word)}</strong><small>You typed “${escapeHtml(m.answer)}”</small></div><span class="mistake-count">${m.count} time${m.count === 1 ? '' : 's'}</span></div>`).join('') : empty('A fresh page.', 'Your recurring misspellings will appear here after you practise.');
}
function fillSettings() {
  const form = $('#settings-form');
  Object.entries(state.settings).forEach(([key,value]) => {const field = form.elements.namedItem(key);if (!field) return;if (field.type === 'checkbox') field.checked = value;else field.value = value;});
  form.elements.clear_proxy_password.checked = false;
  $('#proxy-password-note').textContent = state.settings.proxy_password_set ? 'saved locally' : 'optional';
}
function renderKeys() {
  const keys = state.enrichment.keys;
  $('#key-count').textContent = `${keys.length} key${keys.length === 1 ? '' : 's'} configured`;
  $('#key-usage').innerHTML = keys.length ? keys.map(k => `<div class="key-row"><span class="status-dot"></span><span>${escapeHtml(k.label)}</span><span class="badge ${k.available ? 'confident' : 'pending'}">${k.available ? 'Ready' : escapeHtml(k.reason || 'Budget reached')}</span><span>${k.requests} / ${k.budget} requests</span></div>`).join('') : '<p class="muted small">Add keys below to enable optional word preparation. Manual practice works without them.</p>';
}
function settingsPayload() {
  const form = $('#settings-form'), result = {};
  ['proxy_enabled','auto_ai','clear_proxy_password'].forEach(k => result[k] = form.elements[k].checked);
  ['proxy_type','proxy_host','proxy_username','proxy_password','model'].forEach(k => result[k] = form.elements[k].value.trim());
  ['proxy_port','batch_size','daily_budget','requests_per_minute'].forEach(k => result[k] = Number(form.elements[k].value));
  return result;
}
async function saveSettings() {
  if (!$('#settings-form').reportValidity()) throw new Error('Please check the settings fields.');
  state.settings = await api('/settings','PUT',settingsPayload());
  fillSettings();
}
function openWord(id = null) {
  editingId = id;
  dictionaryData = null; dictionaryApplied = false; addMode = 'single';
  $('#word-form').reset();
  $('#add-tabs').hidden = id !== null;
  $('#single-fields').hidden = false; $('#bulk-fields').hidden = true;
  $$('[data-add-mode]').forEach(b => b.classList.toggle('active',b.dataset.addMode === 'single'));
  $('#dictionary-choices').hidden = true;
  $('#lookup-status').textContent = 'Or add the details yourself.';
  $('#word-dialog-title').textContent = id ? 'Make this word your own.' : 'A word worth remembering.';
  $('#word-submit').innerHTML = (id ? 'Save changes' : 'Add to notebook') + icon(id ? 'check' : 'plus');
  $('#word-save-note').innerHTML = id ? `<button type="button" class="text-button" data-action="delete-word">${icon('trash')}Remove word</button>` : 'Saved locally. Prepared at your pace.';
  const form = $('#word-form');
  form.elements.word.readOnly = id !== null;
  if (id) {const word = state.words.find(w => w.id === id);['word','definition','sentence','tip','tag'].forEach(k => form.elements[k].value = word[k]);}
  $('#word-dialog').showModal();
  setTimeout(() => form.elements.word.focus(),30);
}
async function lookupWord(button) {
  const word = $('#word-form').elements.word.value.trim();
  if (!word) throw new Error('Enter a word before looking it up.');
  $('#lookup-status').textContent = 'Looking up the dictionary…';
  try {
    dictionaryData = await api('/dictionary','POST',{word});
    $('#dictionary-sense').innerHTML = dictionaryData.senses.map((s,i) => `<option value="${i}">${escapeHtml((s.pos ? s.pos + ' · ' : '') + s.definition)}</option>`).join('');
    $('#dictionary-choices').hidden = false;
    $('#lookup-status').textContent = dictionaryData.cached ? 'Cambridge · saved lookup' : 'Cambridge Dictionary';
    applyDictionarySense();
  } catch (error) {$('#lookup-status').textContent = 'You can add the details manually.';throw error;}
}
function applyDictionarySense() {
  const sense = dictionaryData.senses[Number($('#dictionary-sense').value)];
  $('#word-form').elements.definition.value = sense.definition;
  $('#dictionary-example').innerHTML = '<option value="">Write my own sentence</option>' + sense.examples.map(e => `<option value="${escapeHtml(e)}">${escapeHtml(e)}</option>`).join('');
  if (sense.examples.length) {$('#dictionary-example').selectedIndex = 1;$('#word-form').elements.sentence.value = sense.examples[0];}
  dictionaryApplied = true;
}
async function saveWord(event) {
  event.preventDefault();
  await guarded(async () => {
    const form = $('#word-form');
    let result;
    if (editingId) {
      const data = Object.fromEntries(['definition','sentence','tip','tag'].map(k => [k,form.elements[k].value]));
      if (dictionaryApplied) {data.source = 'Cambridge';data.audio_url = dictionaryData.audio.uk || dictionaryData.audio.us || '';}
      result = await api('/words/' + editingId,'PATCH',data);
      toast('Word updated.');
    } else {
      const words = addMode === 'bulk' ? form.elements.bulk.value.split(/[\n,;]/).map(w => w.trim()).filter(Boolean).map(word => ({word,tag:form.elements.tag.value})) : [Object.fromEntries(['word','definition','sentence','tip','tag'].map(k => [k,form.elements[k].value]))];
      result = await api('/words','POST',{words});
      if (dictionaryApplied && result.added.length && addMode === 'single') {
        await api('/words/' + result.added[0],'PATCH',{definition:form.elements.definition.value,sentence:form.elements.sentence.value,source:'Cambridge',audio_url:dictionaryData.audio.uk || dictionaryData.audio.us || ''});
      }
      toast(`${result.added.length} word${result.added.length === 1 ? '' : 's'} added.${result.duplicates.length ? ` ${result.duplicates.length} already in your notebook.` : ''}`);
    }
    $('#word-dialog').close();
    await refresh();
  },$('#word-submit'));
}

const starterWords = [
  ['necessary','Needed for a particular purpose.','Regular practice is necessary for steady improvement.','One c, two s.'],
  ['accommodation','A place to stay.','The university provides affordable accommodation for students.','Two c letters and two m letters.'],
  ['environment','The natural world and the conditions around us.','Public transport can help protect the environment.','Keep the n in environ before adding ment.'],
  ['government','The group responsible for governing a country.','The government should invest in public education.','Keep the n: govern + ment.'],
  ['definitely','Without doubt.','Better planning would definitely improve the service.','Remember finite inside definitely.'],
  ['opportunity','A chance to do something.','Studying abroad offers an opportunity to experience another culture.','Two p letters, then ortunity.'],
  ['successful','Achieving the intended result.','A successful policy needs public support.','Success + ful: two c letters, two s letters, one l at the end.'],
  ['responsibility','A duty to take care of something.','Protecting public spaces is a shared responsibility.','The ending is ibility.'],
  ['separate','Not joined or connected.','The report discusses these issues in separate sections.','There is a rat in separate: se-pa-rat-e.'],
  ['receive','To get or be given something.','Students should receive clear feedback on their work.','For this word, the sequence after c is ei.'],
  ['development','The process of growing or improving.','Economic development can create new employment opportunities.','Develop + ment, with one p.'],
  ['achievement','Something accomplished through effort.','Completing the course was a significant achievement.','Achieve keeps its e before ment.'],
].map(([word,definition,sentence,tip]) => ({word,definition,sentence,tip,tag:'Starter collection'}));
async function addStarter() {
  const result = await api('/words','POST',{words:starterWords});
  await refresh();
  toast(result.added.length ? `${result.added.length} starter words added. No API calls needed.` : 'The starter words are already in your notebook.');
}
function chooseDrill(id) {
  if (!state.words.length) {openWord();toast('Add a word to start your first drill.');return;}
  $('#drill-word').innerHTML = [...state.words].sort((a,b) => a.word.localeCompare(b.word)).map(w => `<option value="${w.id}">${escapeHtml(w.word)}</option>`).join('');
  if (id) $('#drill-word').value = id;
  $('#drill-dialog').showModal();
}
function startReview(ids) {
  let words = ids ? state.words.filter(w => ids.includes(w.id)) : dueWords().slice(0,10);
  if (!words.length) {
    if (!state.words.length) {openWord();toast('Add some words, or try the starter collection.');}
    else {toast('Your scheduled reviews are done. Choose words in My words for extra practice.');navigate('words');}
    return;
  }
  practice = {mode:'review',queue:words,index:0,attempts:0,correct:0,hinted:false,feedback:false,correction:false,started:Date.now(),repetitions:0};
  openPractice();
}
function startDrill(event) {
  event.preventDefault();
  const word = state.words.find(w => w.id === Number($('#drill-word').value));
  if (!word) return;
  $('#drill-dialog').close();
  practice = {mode:'drill',queue:[word],index:0,attempts:0,correct:0,hinted:false,feedback:false,correction:false,started:Date.now(),repetitions:0,target:Number($('#drill-target').value),show:$('#drill-show').checked};
  openPractice();
}
function openPractice() {
  $('#practice-summary').hidden = true; $('#practice-active').hidden = false;
  $('#practice-dialog').showModal();
  renderPractice();
}
function currentWord() {return practice.queue[practice.mode === 'drill' ? 0 : practice.index];}
function concealed(word, text) {return String(text || '').replace(new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'________');}
function renderPractice() {
  const word = currentWord(), drill = practice.mode === 'drill';
  practice.feedback = false; practice.hinted = false; practice.wordStarted = Date.now();
  $('#practice-mode').textContent = drill ? 'WORD DRILL · FIND YOUR RHYTHM' : 'DAILY REVIEW · ONE WORD AT A TIME';
  $('#practice-count').textContent = drill ? (practice.target ? `${practice.correct} OF ${practice.target} CORRECT REPETITIONS` : `${practice.correct} CORRECT REPETITIONS · YOUR OWN PACE`) : `WORD ${practice.index + 1} OF ${practice.queue.length}`;
  $('#practice-meter-fill').style.width = (drill ? (practice.target ? Math.min(100,100 * practice.correct / practice.target) : 0) : 100 * practice.index / practice.queue.length) + '%';
  $('#practice-label').textContent = drill ? 'STAY WITH THIS WORD' : practice.correction ? 'A CHANCE TO PRACTISE THE CORRECTION' : 'WHAT’S THE MISSING WORD?';
  $('#practice-word').textContent = drill && practice.show || practice.correction ? word.word : '';
  $('#practice-clue').textContent = drill ? (practice.show ? '' : 'Listen, remember, and type.') : word.clue || 'Listen to the word, then type its spelling.';
  $('#practice-meaning').textContent = concealed(word.word,word.definition) || (drill ? 'Type, check, repeat. Let yourself settle into a rhythm.' : 'No clue yet? Reveal the spelling to learn it first.');
  $('#hint-button').hidden = drill || practice.correction;
  $('#practice-show-control').hidden = !drill;
  $('#practice-show').checked = !!practice.show;
  $('#practice-feedback').innerHTML = '';
  $('#answer').value = '';
  $('#answer').disabled = false;
  $('#answer-submit').innerHTML = 'Check spelling' + icon('arrow');
  setTimeout(() => $('#answer').focus(),20);
}
function letterDiff(expected, answer) {
  // Levenshtein alignment gives useful feedback for omissions and extra letters.
  const a = answer.trim().toLowerCase(), b = expected;
  const matrix = Array.from({length:a.length+1},() => Array(b.length+1).fill(0));
  for (let i=0;i<=a.length;i++) matrix[i][0]=i;
  for (let j=0;j<=b.length;j++) matrix[0][j]=j;
  for (let i=1;i<=a.length;i++) for (let j=1;j<=b.length;j++) matrix[i][j]=Math.min(matrix[i-1][j]+1,matrix[i][j-1]+1,matrix[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  let i=a.length,j=b.length,parts=[];
  while (i || j) {
    if (i && j && matrix[i][j]===matrix[i-1][j-1]+(a[i-1]===b[j-1]?0:1)) {parts.push(`<span class="${a[i-1]===b[j-1]?'':'missing'}">${escapeHtml(b[j-1])}</span>`);i--;j--;}
    else if (j && matrix[i][j]===matrix[i][j-1]+1) {parts.push(`<span class="missing">${escapeHtml(b[j-1])}</span>`);j--;}
    else {parts.push(`<span class="extra">${escapeHtml(a[i-1])}</span>`);i--;}
  }
  return '<div class="letter-diff" aria-label="Correct spelling with changes highlighted">'+parts.reverse().join('')+'</div>';
}
async function answerSubmit(event) {
  event.preventDefault();
  if (!practice) return;
  if (practice.feedback) {
    if (practice.mode === 'drill') {renderPractice();return;}
    if (practice.lastCorrect) {practice.index++;practice.correction = false;if (practice.index >= practice.queue.length) finishPractice();else renderPractice();}
    else {practice.correction = true;renderPractice();}
    return;
  }
  const answer = $('#answer').value;
  if (!answer.trim()) {$('#answer').focus();return;}
  await guarded(async () => {
    const word = currentWord();
    const mode = practice.mode === 'drill' ? 'drill' : practice.correction ? 'correction' : 'review';
    const result = await api(`/words/${word.id}/attempts`,'POST',{answer,mode,hinted:practice.hinted || practice.correction,elapsed_ms:Math.min(86400000,Date.now()-practice.wordStarted)});
    practice.lastCorrect = result.correct; practice.feedback = true;
    if (mode !== 'correction') {practice.attempts++;if (result.correct) practice.correct++;}
    $('#answer').disabled = true;
    $('#practice-feedback').innerHTML = result.correct ? `<div class="feedback-heading">${practice.hinted ? 'That’s right. Try recalling it unaided next time.' : practice.correction ? 'Nicely corrected. Keep that spelling in mind.' : 'That’s right. A little more familiar.'}</div>${result.tip ? `<span class="muted">${escapeHtml(result.tip)}</span>` : ''}` : `<div class="feedback-heading incorrect">Take another look. You’re learning the tricky part.</div>${letterDiff(result.expected,result.answer)}<span class="muted">${escapeHtml(result.tip || 'Notice the highlighted letters, then try again.')}</span>`;
    $('#answer-submit').innerHTML = (practice.mode === 'drill' ? 'Type it again' : result.correct ? practice.index + 1 >= practice.queue.length ? 'See my session' : 'Next word' : 'Practise the correction') + icon('arrow');
    if (practice.mode === 'drill' && practice.target && practice.correct >= practice.target) {finishPractice();}
    else if (practice.mode === 'drill' && result.correct) {setTimeout(() => {if (practice && practice.mode === 'drill' && practice.feedback && $('#practice-dialog').open && !$('#practice-active').hidden) renderPractice();},650);}
    else $('#answer-submit').focus();
  },$('#answer-submit'));
}
function finishPractice() {
  if (!practice) return;
  const p = practice, minutes = Math.max(1,Math.round((Date.now()-p.started)/60000));
  $('#practice-active').hidden = true; $('#practice-summary').hidden = false;
  $('#practice-meter-fill').style.width = '100%';
  $('#practice-summary').innerHTML = `<div class="practice-summary"><div class="summary-mark">✳</div><span class="eyebrow">A LITTLE PROGRESS, MADE</span><h2>${p.mode === 'drill' ? 'A word, a little more familiar.' : 'You showed up for your words.'}</h2><p>${p.mode === 'drill' ? 'Your repetitions are saved. Come back later to check what you remember.' : 'Every attempt gives your next review a little more direction.'}</p><div class="summary-stats"><div><strong>${p.attempts}</strong><span>${p.mode === 'drill' ? 'repetitions' : 'review attempts'}</span></div><div><strong>${p.correct}</strong><span>correct answers</span></div><div><strong>${minutes}</strong><span>minutes of focus</span></div></div><button class="button primary" data-action="close-practice">Back to my notebook${icon('arrow')}</button></div>`;
  guarded(refresh);
}
async function listen(button) {
  if (!practice) return;
  const id = currentWord().id;
  // Fetch from our backend so pronunciation follows the configured proxy too.
  const response = await fetch(`/api/words/${id}/audio`);
  if (!response.ok) {const result = await response.json();throw new Error(result.error || 'Pronunciation is unavailable.');}
  const url = URL.createObjectURL(await response.blob()), audio = new Audio(url);
  audio.addEventListener('ended',() => URL.revokeObjectURL(url),{once:true});
  audio.addEventListener('error',() => URL.revokeObjectURL(url),{once:true});
  try {await audio.play();} catch {URL.revokeObjectURL(url);throw new Error('Your browser could not play this pronunciation.');}
}
async function prepare(ids) {
  const result = await api('/enrichment/run','POST',ids ? {ids} : {});
  toast(result.message); await refresh();
}

const actions = {
  add:() => openWord(), starter:addStarter, review:() => startReview(), 'choose-drill':() => chooseDrill(),
  'prepare-all':() => prepare(), 'prepare-selected':() => prepare([...selected]),
  'review-selected':() => startReview([...selected]), 'clear-selection':() => {selected.clear();renderLibrary();},
  lookup:lookupWord,
  'test-network':async () => {await saveSettings();$('#network-result').textContent = 'Testing…';try {const r = await api('/network/test','POST',{});$('#network-result').textContent = r.message;toast(r.message);} catch(error) {$('#network-result').textContent = 'Connection failed.';throw error;}},
  'save-keys':async () => {const result = await api('/keys','PUT',{keys:$('#api-keys').value});$('#api-keys').value = '';await refresh();toast(`${result.count} keys saved locally.`);},
  import:() => $('#import-file').click(),
  'delete-word':() => {deletingId = editingId;$('#confirm-message').textContent = `This removes “${state.words.find(w => w.id === editingId).word}” and its practice history from this notebook.`;$('#confirm-dialog').showModal();},
  hint:() => {if (!practice) return;practice.hinted = true;$('#practice-word').textContent = currentWord().word;$('#hint-button').hidden = true;$('#practice-label').textContent = 'LOOK, REMEMBER, THEN TYPE';$('#answer').focus();},
  listen,
  'finish-practice':() => {if ($('#practice-summary').hidden) finishPractice();else actions['close-practice']();},
  'close-practice':() => {$('#practice-dialog').close();practice = null;},
};
document.addEventListener('click',event => {
  const page = event.target.closest('[data-page]');if (page) {navigate(page.dataset.page);return;}
  const close = event.target.closest('[data-close]');if (close) {$('#'+close.dataset.close).close();return;}
  const edit = event.target.closest('[data-edit]');if (edit) {openWord(Number(edit.dataset.edit));return;}
  const drill = event.target.closest('[data-drill]');if (drill) {chooseDrill(Number(drill.dataset.drill));return;}
  const filter = event.target.closest('[data-filter]');if (filter) {wordFilter = filter.dataset.filter;$$('[data-filter]').forEach(b => b.classList.toggle('active',b===filter));renderLibrary();return;}
  const mode = event.target.closest('[data-add-mode]');if (mode) {addMode = mode.dataset.addMode;$('#single-fields').hidden = addMode !== 'single';$('#bulk-fields').hidden = addMode !== 'bulk';$$('[data-add-mode]').forEach(b => b.classList.toggle('active',b===mode));return;}
  const action = event.target.closest('[data-action]');if (action && actions[action.dataset.action] && !action.disabled) guarded(() => actions[action.dataset.action](action),action);
});
document.addEventListener('change',event => {
  if (event.target.dataset.select) {const id = Number(event.target.dataset.select);if(event.target.checked) selected.add(id);else selected.delete(id);renderLibrary();}
});
$('#select-all').addEventListener('change',event => {visibleWords().forEach(w => event.target.checked ? selected.add(w.id) : selected.delete(w.id));renderLibrary();});
$('#word-search').addEventListener('input',renderLibrary);
$('#word-form').addEventListener('submit',saveWord);
$('#drill-form').addEventListener('submit',startDrill);
$('#answer-form').addEventListener('submit',answerSubmit);
$('#dictionary-sense').addEventListener('change',applyDictionarySense);
$('#dictionary-example').addEventListener('change',() => {$('#word-form').elements.sentence.value = $('#dictionary-example').value;});
$('#word-form').elements.word.addEventListener('input',() => {dictionaryData = null;dictionaryApplied = false;$('#dictionary-choices').hidden = true;});
$('#practice-show').addEventListener('change',event => {if (practice) {practice.show = event.target.checked;$('#practice-word').textContent = practice.show ? currentWord().word : '';}});
$('#settings-form').addEventListener('submit',event => {event.preventDefault();guarded(async () => {await saveSettings();await refresh();toast('Settings saved.');},$('#settings-form button[type=submit]'));});
$('#confirm-delete').addEventListener('click',() => guarded(async () => {await api('/words/'+deletingId,'DELETE');$('#confirm-dialog').close();$('#word-dialog').close();await refresh();toast('Word removed.');},$('#confirm-delete')));
$('#import-file').addEventListener('change',event => guarded(async () => {const file = event.target.files[0];if (!file) return;if (file.size > 32*1024*1024) throw new Error('Choose a backup smaller than 32 MB.');let backup;try {backup=JSON.parse(await file.text());} catch {throw new Error('That file is not a valid JSON backup.');}const r=await api('/import','POST',backup);await refresh();toast(`${r.added} words imported. ${r.skipped} existing words kept.`);event.target.value='';}));
$('#practice-dialog').addEventListener('cancel',event => {event.preventDefault();if ($('#practice-summary').hidden) finishPractice();else actions['close-practice']();});
window.addEventListener('hashchange',() => navigate(location.hash.slice(1)));
hydrateIcons();
$('#date-label').textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
guarded(async () => {await refresh();navigate(location.hash.slice(1) || 'today');});
setInterval(async () => {
  if (!state || document.hidden) return;
  try {const job = await api('/enrichment');if (job.busy !== state.enrichment.busy || job.done !== state.enrichment.done || job.pending !== state.enrichment.pending) {await refresh();}else {state.enrichment = job;renderQueue();renderKeys();}}catch { /* Keep the notebook usable during a temporary disconnect. */ }
},4000);
