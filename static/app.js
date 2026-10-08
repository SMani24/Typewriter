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
let state, currentPage = 'today', wordFilter = 'all', selected = new Set(), editingId = null, addMode = 'single', dictionaryData = null, dictionaryApplied = false, practice = null, deletingId = null, toastTimer, audioSequence = 0, answerBusy = false, drillMatches = [], drillHighlight = 0, preparedPreviewText = null;
let pendingFailure = null;
const preparationPending = word => word.status !== 'ready' || !!word.meaning_flagged;
const token = $('meta[name="typewriter-token"]').content;

async function api(path, method = 'GET', data) {
  const response = await fetch('/api' + path, {method, headers:{'Content-Type':'application/json','X-Typewriter-Token':token}, ...(data !== undefined ? {body:JSON.stringify(data)} : {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Please try again.');
  return result;
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  // Native modal dialogs sit above the page, including any page-level z-index.
  const host = $$('dialog[open]').at(-1) || document.body;
  host.append($('#toast'));
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 8500 : 4500);
}
async function guarded(action, button) {
  if (button) button.disabled = true;
  try { return await action(); } catch (error) { toast(error.message || 'Please try again.', true); }
  finally { if (button) button.disabled = button.id === 'apply-preparation' ? !preparedPreviewText : !!(state?.enrichment.busy && state.settings.preparation_method === 'api' && ['prepare-all','prepare-selected'].includes(button.dataset.action)); }
}
async function refresh() {
  const previousJob = state?.enrichment;
  state = await api('/state');
  const job = state.enrichment;
  if (previousJob && job.id && !job.busy && job.status !== 'idle' && (previousJob.busy || previousJob.id !== job.id)) toast(job.error ? `${job.message} ${job.error}` : job.message, !!job.error);
  selected = new Set([...selected].filter(id => state.words.some(w => w.id === id)));
  $('#loading').hidden = true;
  $('#app-content').hidden = false;
  render();
  offerFailure(job);
}
function offerFailure(job) {
  if (state.settings.preparation_method !== 'api' || job.busy || !job.pending || !job.error || !['failed','partial'].includes(job.status)) return;
  const key = 'typewriter-failure:' + job.id;
  try {if (sessionStorage.getItem(key)) return;sessionStorage.setItem(key,'seen');} catch {if (pendingFailure?.key === key) return;}
  pendingFailure = {key, message:job.error, ids:job.ids};
  showFailure();
}
function showFailure() {
  if (state?.settings.preparation_method !== 'api') {pendingFailure=null;return;}
  if (!pendingFailure || $$('dialog[open]').length) return;
  $('#failure-message').textContent = pendingFailure.message;
  $('#failure-dialog').showModal();
}
async function useAnotherLLM() {
  const ids = pendingFailure?.ids?.filter(id => state.words.some(w => w.id === id && preparationPending(w)));
  await api('/settings','PUT',{preparation_method:'offline'});
  pendingFailure = null;$('#failure-dialog').close();
  await refresh();fillSettings();openPreparation(ids?.length ? ids : undefined);
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
  return `<span class="badge ${type}">${escapeHtml(word.state)}</span>${word.meaning_flagged ? '<span class="badge new">Meaning flagged</span>' : ''}${word.drill_recommended && state.settings.drill_enabled ? '<span class="badge learning">Worth a drill</span>' : ''}`;
}
function dueWords() {
  const meaningOnly = state.settings.meaning_enabled && !['sentence_enabled','definition_enabled','audio_enabled'].some(k=>state.settings[k]);
  return state.words.filter(w => (meaningOnly || w.is_due) && exerciseTypes(w).length).sort((a,b) => (b[meaningOnly ? 'meaning_priority' : 'review_priority'] ?? 0) - (a[meaningOnly ? 'meaning_priority' : 'review_priority'] ?? 0) || a.due.localeCompare(b.due));
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
  $('#hero-note').textContent = due.length ? `Up to ${Math.min(due.length,state.settings.review_session_size ?? 10)} words · Or keep going endlessly` : 'No due spelling words · Endless review is extra practice';
  const next = (due.length ? due : state.words).slice(0,4);
  $('#next-words').innerHTML = next.length ? next.map(w => `<div class="next-word"><span class="word-initial">${escapeHtml(w.word[0])}</span><div><div class="next-word-name">${escapeHtml(w.word)}</div><div class="next-word-definition">${escapeHtml(w.definition || 'A word waiting for its story')}</div></div>${badge(w)}<button class="icon-button" data-drill="${w.id}" aria-label="Drill ${escapeHtml(w.word)}">${icon('arrow')}</button></div>`).join('') : empty('Start with a word you know.', 'Add a few words from your writing, or try our starter collection.', 'starter', 'Add starter words');
  renderLibrary();
  renderProgress();
  renderQueue();
  renderKeys();
  renderPracticeModes();
  renderDrillSuggestions();
}
function renderDrillSuggestions() {
  const words = state.words.filter(w=>w.drill_recommended).sort((a,b)=>b.recent_mistakes-a.recent_mistakes || b.review_priority-a.review_priority).slice(0,3);
  $('#drill-suggestions').hidden = !words.length || !state.settings.drill_enabled;
  $('#drill-suggestions').innerHTML = `<span class="eyebrow">WORTH A DRILL</span>${words.map(w=>`<button class="drill-suggestion" data-drill="${w.id}"><span>${escapeHtml(w.word)}<small>${w.recent_mistakes} misses in ${w.recent_reviews} recent reviews</small></span>${icon('arrow')}</button>`).join('')}<p class="field-note">Suggestions clear after three consecutive correct unaided reviews. Drills and corrections don’t count as recall.</p>`;
}
function visibleWords() {
  const query = $('#word-search').value.toLowerCase().trim();
  return state.words.filter(w => (!query || [w.word,w.definition,w.tag].some(s => s.toLowerCase().includes(query))) && (wordFilter === 'all' || wordFilter === 'due' && w.is_due || wordFilter === 'learning' && ['New','Learning'].includes(w.state) || wordFilter === 'confident' && w.state === 'Confident' || wordFilter === 'pending' && preparationPending(w)));
}
function renderLibrary() {
  const words = visibleWords();
  $('#word-list').innerHTML = words.length ? words.map(w => `<div class="library-row"><div class="library-word"><input type="checkbox" data-select="${w.id}" aria-label="Select ${escapeHtml(w.word)}" ${selected.has(w.id) ? 'checked' : ''}><div><strong>${escapeHtml(w.word)} ${badge(w)}</strong><p title="${escapeHtml(w.definition || w.enrichment_error || 'Waiting for preparation')}">${escapeHtml(w.definition || (w.enrichment_error ? 'Preparation paused — try again or edit' : 'Waiting for a meaning'))}${w.tag ? ` · ${escapeHtml(w.tag)}` : ''}</p></div></div><div class="recall">${w.accuracy === null ? '—' : w.accuracy + '%'}<small>${w.reviews ? w.reviews + ' reviews' : 'Not reviewed'}</small></div><div class="due-date">${w.is_due ? '<strong>Ready today</strong>' : escapeHtml(new Date(w.due).toLocaleDateString(undefined,{month:'short',day:'numeric'}))}</div><div class="library-actions"><button class="icon-button" data-drill="${w.id}" aria-label="Drill ${escapeHtml(w.word)}">${icon('keyboard')}</button><button class="icon-button" data-edit="${w.id}" aria-label="Edit ${escapeHtml(w.word)}">${icon('edit')}</button></div></div>`).join('') : empty(state.words.length ? 'No words here just yet.' : 'Every notebook begins somewhere.', state.words.length ? 'Try a different search or filter.' : 'Add words from your essays, reading, or everyday life.', state.words.length ? '' : 'add', 'Add your first words');
  $('#selection-bar').hidden = selected.size === 0;
  $('#selection-count').textContent = `${selected.size} word${selected.size === 1 ? '' : 's'} selected`;
  $('#select-all').checked = words.length > 0 && words.every(w => selected.has(w.id));
  $('#select-all').indeterminate = words.some(w => selected.has(w.id)) && !$('#select-all').checked;
  renderPracticeModes();
}
function renderQueue() {
  const job = state.enrichment, usesApi = state.settings.preparation_method === 'api';
  const message = job.busy || usesApi && job.total ? job.message : job.pending ? `${job.pending} words waiting to be prepared` : 'Your words are ready when you are.';
  const detail = (usesApi || job.busy ? job.error : '') || (job.busy ? 'You can keep practising while this runs.' : job.pending ? state.settings.preparation_method === 'offline' ? `${job.pending} words queued for prompt export. No API calls are enabled.` : state.settings.preparation_method === 'manual' ? `${job.pending} words need material. Add definitions, sentences, and tips in the word editor.` : `${job.pending} words queued. Prepare a set now, or wait for an automatic batch of ${state.settings.batch_size}.` : 'Meanings, sentences, and tips can always be edited.');
  const content = `${icon('spark')}<div><span>${escapeHtml(message)}</span><p>${escapeHtml(detail)}</p></div>${job.pending && state.settings.preparation_method !== 'manual' ? `<button class="text-button" data-action="prepare-all" ${job.busy ? 'disabled' : ''}>${state.settings.preparation_method === 'offline' ? 'Export prompts' : 'Prepare now'}${icon('arrow')}</button>` : ''}`;
  for (const el of [$('#queue-banner'), $('#today-preparation')]) {
    el.classList.toggle('busy', job.busy);
    el.classList.toggle('failed', !!job.error && (usesApi || job.busy));
    el.innerHTML = content;
  }
  $('#today-preparation').hidden = !job.busy && (!usesApi || !job.error && !job.total);
  $('#settings-pending').textContent = usesApi || job.busy ? `${job.message}${job.error ? ' ' + job.error : ''}` : `${job.pending} words need material · ${usesApi ? 'Gemini API' : state.settings.preparation_method === 'offline' ? 'prompt export/import' : 'manual entry'}`;
  $$('[data-action="prepare-all"], [data-action="prepare-selected"]').forEach(b => {b.disabled = (job.busy && state.settings.preparation_method === 'api') || !job.pending;b.hidden = state.settings.preparation_method === 'manual';});
  $('#app-log').innerHTML = state.logs.length ? state.logs.map(r => `<div class="log-entry ${escapeHtml(r.level)}"><time>${escapeHtml(new Date(r.created).toLocaleString())}</time><span>${escapeHtml(r.message)}</span></div>`).join('') : '<p class="muted small">No events yet. Preparation results will appear here.</p>';
}
function renderPracticeModes() {
  $$('[data-action="review"], [data-action="review-selected"], [data-action="review-endless"], [data-action="review-selected-endless"]').forEach(b => b.hidden = !state.settings.review_enabled);
  $('.drill-card').hidden = !state.settings.drill_enabled;
  $$('[data-drill]').forEach(b => b.hidden = !state.settings.drill_enabled);
}
function renderProgress() {
  const p = state.progress;
  $('#meaning-progress').textContent = p.meanings ? `${p.meanings} meaning quizzes · ${Math.round(100*p.meanings_correct/p.meanings)}% correct · separate from spelling recall` : 'Meaning quiz results will appear here, separate from spelling recall.';
  $('#progress-stats').innerHTML = stat('Unaided review attempts',p.reviews,'First answers, without revealed spelling','book') + stat('Correctly remembered',p.correct,'Progress you can build on','check') + stat('Drill repetitions',p.drills,'Focused practice, counted separately','keyboard');
  const days = Array.from({length:7},(_,i) => {const d = new Date(); d.setUTCDate(d.getUTCDate() - (6-i)); return d.toISOString().slice(0,10);});
  const maximum = Math.max(5,...p.history.map(d => d.total));
  $('#activity-chart').innerHTML = days.map(day => {const data = p.history.find(h => h.day === day) || {total:0,correct:0};return `<div class="chart-day"><span class="chart-value">${data.total || '·'}</span><div class="bar-track"><div class="bar-total" data-height="${Math.max(3,128 * data.total / maximum)}"><div class="bar-correct" data-height="${data.total ? 100 * data.correct / data.total : 0}" data-percent="true"></div></div></div><span>${new Date(day + 'T12:00:00Z').toLocaleDateString(undefined,{weekday:'short',timeZone:'UTC'})}</span></div>`;}).join('');
  $$('[data-height]', $('#activity-chart')).forEach(el => el.style.height = el.dataset.height + (el.dataset.percent ? '%' : 'px'));
  $('#mistake-list').innerHTML = p.mistakes.length ? p.mistakes.map(m => `<div class="mistake"><div><strong>${escapeHtml(m.word)}</strong><small>You typed “${escapeHtml(m.answer)}”</small></div><span class="mistake-count">${m.count} time${m.count === 1 ? '' : 's'}</span></div>`).join('') : empty('A fresh page.', 'Your recurring misspellings will appear here after you practise.');
}
function fillSettings() {
  const form = $('#settings-form');
  Object.entries(state.settings).forEach(([key,value]) => {const field = form.elements.namedItem(key);if (!field) return;if (field.type === 'checkbox') field.checked = value;else field.value = value;});
  form.elements.clear_proxy_password.checked = false;
  form.elements.auto_ai.disabled = state.settings.preparation_method !== 'api';
  form.elements.quiz_interval_fixed.value = state.settings.quiz_interval_min;
  updateQuizRhythm();
  $('#proxy-password-note').textContent = state.settings.proxy_password_set ? 'saved locally' : 'optional';
}
function updateQuizRhythm(changed) {
  const form = $('#settings-form'), fixed = form.elements.quiz_interval_mode.value === 'fixed';
  const minimum = form.elements.quiz_interval_min, maximum = form.elements.quiz_interval_max;
  if (Number(minimum.value) > Number(maximum.value)) {
    if (changed === maximum) minimum.value = maximum.value;else maximum.value = minimum.value;
  }
  $('#quiz-fixed-controls').hidden = !fixed;$('#quiz-range-controls').hidden = fixed;
  const low = Number(fixed ? form.elements.quiz_interval_fixed.value : minimum.value), high = fixed ? low : Number(maximum.value);
  $('#quiz-fixed-value').value = form.elements.quiz_interval_fixed.value;
  $('#quiz-min-value').value = minimum.value;$('#quiz-max-value').value = maximum.value;
  $('#quiz-rhythm-label').textContent = fixed ? `One quiz after every ${low} spelling ${low===1 ? 'word' : 'words'}` : `A quiz after ${low}–${high} spelling words`;
  $('#quiz-rhythm-note').textContent = !form.elements.meaning_enabled.checked ? 'Enable meaning quizzes above to use this rhythm.' : fixed ? 'A steady rhythm, starting with spelling.' : 'A fresh random gap is chosen after each quiz.';
  const settings = {quiz_interval_mode:fixed ? 'fixed' : 'range',quiz_interval_min:low,quiz_interval_max:high};
  let untilQuiz = TypewriterReview.gap(settings), preview = '';
  for (let i=0;i<12;i++) {
    preview += '<span class="rhythm-word">Aa</span>';
    if (--untilQuiz === 0) {preview += '<span class="rhythm-quiz">?</span>';untilQuiz=TypewriterReview.gap(settings);}
  }
  $('#quiz-rhythm-preview').innerHTML = preview;
  $('#quiz-rhythm').classList.toggle('inactive',!form.elements.meaning_enabled.checked);
}
function renderKeys() {
  const keys = state.enrichment.keys;
  $('#key-count').textContent = `${keys.length} key${keys.length === 1 ? '' : 's'} configured`;
  $('#key-usage').innerHTML = keys.length ? keys.map(k => `<div class="key-row"><span class="status-dot"></span><span>${escapeHtml(k.label)}</span><span class="badge ${k.available ? 'confident' : 'pending'}">${k.available ? 'Ready' : escapeHtml(k.reason || 'Budget reached')}</span><span>${k.requests} / ${k.budget} requests</span></div>`).join('') : '<p class="muted small">Add keys below to enable optional word preparation. Manual practice works without them.</p>';
}
function settingsPayload() {
  const form = $('#settings-form'), result = {};
  ['proxy_enabled','auto_ai','review_enabled','drill_enabled','sentence_enabled','definition_enabled','audio_enabled','meaning_enabled','clear_proxy_password'].forEach(k => result[k] = form.elements[k].checked);
  ['proxy_type','proxy_host','proxy_username','proxy_password','model','preparation_method','pronunciation_accent'].forEach(k => result[k] = form.elements[k].value.trim());
  ['proxy_port','batch_size','daily_budget','requests_per_minute','offline_batch_size','review_session_size'].forEach(k => result[k] = Number(form.elements[k].value));
  result.quiz_interval_mode = form.elements.quiz_interval_mode.value;
  result.quiz_interval_min = Number(form.elements[result.quiz_interval_mode === 'fixed' ? 'quiz_interval_fixed' : 'quiz_interval_min'].value);
  result.quiz_interval_max = result.quiz_interval_mode === 'fixed' ? result.quiz_interval_min : Number(form.elements.quiz_interval_max.value);
  return result;
}
async function saveSettings() {
  if (!$('#settings-form').reportValidity()) throw new Error('Please check the settings fields.');
  const requestedModel = $('#settings-form').elements.model.value.trim();
  state.settings = await api('/settings','PUT',settingsPayload());
  $('#model-note').textContent = requestedModel !== state.settings.model ? `Model name corrected to ${state.settings.model}.` : 'Availability is checked before generation. Refresh the list to see available models.';
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
  $('#word-audio-panel').hidden = !id;
  $('#word-meaning-panel').hidden = !id;
  if (id) {renderWordAudio();renderWordMeaning();}
  $('#audio-preview').pause();$('#audio-preview').removeAttribute('src');$('#audio-preview').load();
  const form = $('#word-form');
  form.elements.word.readOnly = id !== null;
  if (id) {const word = state.words.find(w => w.id === id);['word','definition','sentence','tip','tag'].forEach(k => form.elements[k].value = word[k]);$('#word-provenance').textContent = ['definition','sentence','tip'].filter(k => word[k]).map(k => ({definition:'Meaning',sentence:'Sentence',tip:'Tip'})[k] + ': ' + (word.sources[k] || 'manual')).join(' · ');}
  else $('#word-provenance').textContent = 'Automatic suggestions are labelled with their source. You can edit every field.';
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
      if (dictionaryApplied) {data.source = 'Cambridge';data.audio_url = dictionaryData.audio[state.settings.pronunciation_accent || 'uk'] || '';data.audio_urls = dictionaryData.audio;}
      result = await api('/words/' + editingId,'PATCH',data);
      toast('Word updated.');
    } else {
      const words = addMode === 'bulk' ? form.elements.bulk.value.split(/[\n,;]/).map(w => w.trim()).filter(Boolean).map(word => ({word,tag:form.elements.tag.value})) : [Object.fromEntries(['word','definition','sentence','tip','tag'].map(k => [k,form.elements[k].value]))];
      result = await api('/words','POST',{words});
      if (dictionaryApplied && result.added.length && addMode === 'single') {
        await api('/words/' + result.added[0],'PATCH',{definition:form.elements.definition.value,sentence:form.elements.sentence.value,source:'Cambridge',audio_url:dictionaryData.audio[state.settings.pronunciation_accent || 'uk'] || '',audio_urls:dictionaryData.audio});
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
  if (!state.settings.drill_enabled) return;
  if (!state.words.length) {openWord();toast('Add a word to start your first drill.');return;}
  $('#drill-search').value = id ? state.words.find(w => w.id === id).word : '';
  $('#drill-word').value = id || '';
  filterDrillWords();
  $('#drill-dialog').showModal();
  setTimeout(() => {$('#drill-search').focus();$('#drill-search').select();},20);
}
function showDrillOptions(open) {
  $('#drill-options').hidden = !open;
  $('#drill-search').setAttribute('aria-expanded', String(open));
  if (!open) $('#drill-search').removeAttribute('aria-activedescendant');
}
function filterDrillWords() {
  const query = $('#drill-search').value.trim().toLowerCase();
  drillMatches = state.words.filter(w => w.word.includes(query)).sort((a,b) => Number(b.word.startsWith(query)) - Number(a.word.startsWith(query)) || Number(!!b.drill_recommended)-Number(!!a.drill_recommended) || a.word.localeCompare(b.word));
  drillHighlight = Math.max(0, drillMatches.findIndex(w => w.word === query));
  $('#drill-word').value = drillMatches.find(w => w.word === query)?.id || '';
  showDrillOptions(true);
  renderDrillOptions();
}
function renderDrillOptions() {
  const input = $('#drill-search'), word = drillMatches[drillHighlight];
  $('#drill-options').innerHTML = drillMatches.length ? drillMatches.map((w,i) => `<div id="drill-option-${w.id}" role="option" aria-selected="${i === drillHighlight}" data-drill-option="${i}" class="word-option ${i === drillHighlight ? 'active' : ''}">${escapeHtml(w.word)}${w.drill_recommended ? '<small>Suggested · '+w.recent_mistakes+' misses</small>' : w.tag ? `<small>${escapeHtml(w.tag)}</small>` : ''}</div>`).join('') : '<div class="no-word-options">No matching words</div>';
  if (word && !$('#drill-options').hidden) input.setAttribute('aria-activedescendant', `drill-option-${word.id}`);
  else input.removeAttribute('aria-activedescendant');
  const typed = input.value;
  const completion = word && typed && word.word.startsWith(typed.toLowerCase()) && input.selectionStart === typed.length && input.selectionEnd === typed.length ? word.word.slice(typed.length) : '';
  $('#drill-completion').innerHTML = completion ? `<span class="completion-prefix">${escapeHtml(typed)}</span><span>${escapeHtml(completion)}</span>` : '';
  $('#drill-form button[type="submit"]').disabled = !$('#drill-word').value;
  $('#drill-match-count').textContent = drillMatches.length ? `${drillMatches.length} matching word${drillMatches.length === 1 ? '' : 's'}${completion ? ' · Tab to complete' : ''}` : 'No matches. Try a different spelling.';
  if (word) $(`#drill-option-${word.id}`).scrollIntoView({block:'nearest'});
}
function acceptDrillWord() {
  const word = drillMatches[drillHighlight];
  if (!word) return;
  $('#drill-search').value = word.word;
  $('#drill-word').value = word.id;
  $('#drill-search').setSelectionRange(word.word.length,word.word.length);
  $('#drill-completion').textContent = '';
  $('#drill-form button[type="submit"]').disabled = false;
  $('#drill-match-count').textContent = `${word.word} selected`;
  showDrillOptions(false);
}
function reviewPool(ids, endless, settings) {
  const candidates = ids ? state.words.filter(w => ids.includes(w.id)) : state.words;
  const spellable = candidates.filter(w => exerciseTypes(w,settings).some(type=>type!=='meaning'));
  const due = spellable.filter(w=>w.is_due);
  const spelling = (endless ? (due.length ? due : spellable) : ids ? spellable : due)
    .sort((a,b) => (b.review_priority ?? 0)-(a.review_priority ?? 0) || a.due.localeCompare(b.due));
  const quizzes = candidates.filter(w => exerciseTypes(w,settings).includes('meaning'))
    .sort((a,b) => (b.meaning_priority ?? 0)-(a.meaning_priority ?? 0));
  const limit = endless ? 10 : ids ? candidates.length : (settings.review_session_size ?? 10);
  const words = spelling.slice(0,limit).map(w => {
    const types = exerciseTypes(w,settings).filter(type=>type!=='meaning');
    return {...w,exercise:types[w.reviews % types.length]};
  });
  return {words,quizzes:quizzes.slice(0,limit)};
}
function startReview(ids, endless = false) {
  if (!state.settings.review_enabled) return;
  const pool = reviewPool(ids,endless,state.settings);
  const session = TypewriterReview.create(pool.words,pool.quizzes,state.settings,Math.random,{endless});
  if (!session.queue.length) {
    if (!state.words.length) {openWord();toast('Add some words, or try the starter collection.');}
    else {toast('No words are available for the enabled exercises. Add clues, check recordings, or choose other exercises in Settings.');navigate('words');}
    return;
  }
  practice = {...session,scopeIds:ids ? [...ids] : null,mode:'review',attempts:0,correct:0,hinted:false,feedback:false,correction:false,started:Date.now(),repetitions:0};
  openPractice();
}

function startDrill(event) {
  event.preventDefault();
  const word = state.words.find(w => w.id === Number($('#drill-word').value));
  if (!word || !state.settings.drill_enabled) return;
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
function exerciseTypes(word, settings = state.settings) {
  const types = [];
  if (settings.sentence_enabled && word.clue) types.push('sentence');
  if (settings.definition_enabled && word.definition && !word.meaning_flagged) types.push('definition');
  if (settings.audio_enabled && word.audio_eligible) types.push('audio');
  if (settings.meaning_enabled && word.definition && !word.meaning_flagged && (word.distractors.length === 3 || state.words.some(w => w.definition && !w.meaning_flagged && w.definition.trim().toLowerCase() !== word.definition.trim().toLowerCase()))) types.push('meaning');
  return types;
}
function makeMeaningChoices(word) {
  const seen = new Set([word.definition.trim().toLowerCase()]);
  const generated = word.distractors.map((definition,i) => ({id:'distractor:'+i,definition}));
  const others = generated.length === 3 ? generated : state.words.filter(w => {if (w.meaning_flagged) return false;const key = w.definition.trim().toLowerCase();if (!key || seen.has(key)) return false;seen.add(key);return true;});
  const shuffle = list => {for (let i=list.length-1;i>0;i--) {const j=Math.floor(Math.random()*(i+1));[list[i],list[j]]=[list[j],list[i]];}return list;};
  return shuffle([word,...shuffle(others).slice(0,3)]);
}
function renderPractice() {
  stopPronunciation(false);
  const word = currentWord(), drill = practice.mode === 'drill', meaning = !drill && word.exercise === 'meaning', audioOnly = !drill && word.exercise === 'audio' && !practice.correction;
  practice.feedback = false; practice.hinted = false; practice.audioBlocked = false; practice.choice = null; practice.wordStarted = Date.now();
  $('#practice-mode').textContent = drill ? 'WORD DRILL · FIND YOUR RHYTHM' : ({sentence:'SENTENCE SPELLING',definition:'SPELLING FROM A MEANING',audio:'AUDIO-ONLY SPELLING',meaning:'MEANING QUIZ'})[word.exercise];
  $('#practice-count').textContent = drill ? (practice.target ? `${practice.correct} OF ${practice.target} CORRECT REPETITIONS` : `${practice.correct} CORRECT REPETITIONS · YOUR OWN PACE`) : practice.meaningOnly ? (practice.endless ? `QUIZ ${practice.questionsDone + 1} · ENDLESS` : `QUIZ ${practice.index + 1} OF ${practice.queue.length}`) : meaning ? (practice.endless ? 'A MEANING BREAK · ENDLESS' : 'A MEANING BREAK') : `SPELLING WORD ${practice.spellingsDone + 1}${practice.endless ? ' · ENDLESS' : ` OF ${practice.spellingTotal}`}`;
  $('.practice-meter').hidden = !!practice.endless;
  $('#practice-meter-fill').style.width = (drill ? (practice.target ? Math.min(100,100 * practice.correct / practice.target) : 0) : practice.meaningOnly ? 100 * practice.index / practice.queue.length : 100 * practice.spellingsDone / practice.spellingTotal) + '%';
  $('#practice-label').textContent = drill ? 'STAY WITH THIS WORD' : practice.correction ? 'A CHANCE TO PRACTISE THE CORRECTION' : meaning ? 'WHAT DOES THIS WORD MEAN?' : audioOnly ? 'LISTEN AND TYPE' : word.exercise === 'sentence' ? 'WHAT’S THE MISSING WORD?' : 'WHICH WORD HAS THIS MEANING?';
  $('#practice-word').textContent = drill && practice.show || practice.correction || meaning ? word.word : '';
  $('#practice-clue').textContent = drill ? (practice.show ? '' : 'Listen, remember, and type.') : meaning ? 'Choose an option or press 1–4. Your answer is checked straight away.' : audioOnly ? 'Type the spelling you hear.' : word.exercise === 'sentence' ? word.clue : concealed(word.word,word.definition);
  $('#practice-meaning').textContent = drill && !word.meaning_flagged ? concealed(word.word,word.definition) : '';
  $('#hint-button').hidden = drill || practice.correction || meaning;
  $('#practice-show-control').hidden = !drill;
  $('#practice-show').checked = !!practice.show;
  $('[data-action="listen"]', $('#practice-dialog')).hidden = !!word.audio_flagged;
  $('#practice-audio-flag').hidden = !!word.audio_flagged;
  $('#practice-meaning-flag').hidden = !word.definition || !!word.meaning_flagged;
  $('#skip-audio').hidden = !audioOnly;
  $('#playback-status').textContent = '';
  $('#practice-feedback').innerHTML = '';
  delete $('#answer-form').dataset.result;
  $('#answer-form').setAttribute('aria-busy','false');
  $('#answer').removeAttribute('aria-invalid');
  $('#answer').value = '';$('#answer').disabled = false;$('#answer').hidden = meaning;
  $('#meaning-options').hidden = !meaning;
  if (meaning) {
    practice.choices = makeMeaningChoices(word);
    $('#meaning-options').innerHTML = practice.choices.map((w,i) => `<button type="button" class="meaning-choice" data-meaning-choice="${i}" aria-pressed="false"><span>${i+1}</span>${escapeHtml(w.definition)}</button>`).join('');
  }
  $('#answer-submit').hidden = meaning;
  $('#answer-submit').innerHTML = 'Check spelling' + icon('arrow');
  preparePronunciation(word);
  // Start on the user's session/Next action, retaining browser playback permission.
  if (audioOnly) guarded(() => listen(true));
  setTimeout(() => {if ($('#practice-active').hidden) return;if (meaning) $('.meaning-choice')?.focus();else $('#answer').focus();},20);
}
function selectMeaning(index) {
  if (!practice || practice.feedback || answerBusy || currentWord().exercise !== 'meaning' || !practice.choices[index]) return;
  practice.choice = practice.choices[index].id;
  $$('.meaning-choice').forEach((b,i) => {b.classList.toggle('selected',i===index);b.setAttribute('aria-pressed',String(i===index));});
  guarded(() => answerSubmit({preventDefault(){}}));
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
function practiceFeedback(outcome, heading, detail = '') {
  $('#answer-form').dataset.result = outcome;
  $('#practice-feedback').innerHTML = `<div class="feedback-card"><span class="feedback-mark" aria-hidden="true">${icon(outcome === 'correct' ? 'check' : outcome === 'checking' ? 'keyboard' : 'edit')}</span><div class="feedback-content"><div class="feedback-heading">${escapeHtml(heading)}</div>${detail}</div></div>`;
}
async function answerSubmit(event) {
  event.preventDefault();
  if (!practice || answerBusy || $('#practice-active').hidden) return;
  if (practice.feedback) {
    if (practice.mode === 'drill') {renderPractice();return;}
    if (practice.lastCorrect || currentWord().exercise === 'meaning') {practice.correction = false;await advancePractice();}
    else {practice.correction = true;renderPractice();}
    return;
  }
  const meaning = practice.mode === 'review' && currentWord().exercise === 'meaning';
  const answer = meaning ? String(practice.choice || '') : $('#answer').value;
  if (meaning && !practice.choice) {toast('Choose a meaning, or press a number key.');return;}
  if (!answer.trim()) {$('#answer').focus();return;}
  answerBusy = true;
  const session = practice;
  $('#answer-form').setAttribute('aria-busy','true');
  $('#answer').disabled = true;$$('.meaning-choice').forEach(b => b.disabled = true);
  $('#answer-submit').textContent = 'Checking…';
  practiceFeedback('checking','Checking your answer…');
  await guarded(async () => {
    const word = currentWord();
    const mode = practice.mode === 'drill' ? 'drill' : practice.correction ? 'correction' : meaning ? 'meaning' : 'review';
    let result;
    try {
      result = await api(`/words/${word.id}/attempts`,'POST',{answer,mode,...(meaning ? {version:word.version} : {}),hinted:practice.hinted || practice.correction,elapsed_ms:Math.min(86400000,Date.now()-practice.wordStarted)});
    } catch (error) {
      if (practice === session && $('#practice-dialog').open && !$('#practice-active').hidden) practiceFeedback('error','Couldn’t check this answer',`<p>${escapeHtml(error.message || 'Please try again.')}</p>`);
      throw error;
    }
    if (practice !== session || !$('#practice-dialog').open || $('#practice-active').hidden) return;
    const savedWord = state.words.find(w=>w.id===word.id);
    if (savedWord) Object.assign(savedWord,result.word);
    if (mode === 'review') TypewriterReview.recordSpelling(practice,word);
    practice.lastCorrect = result.correct; practice.feedback = true;
    $('#answer-submit').hidden = false;
    if (mode !== 'correction') {practice.attempts++;if (result.correct) practice.correct++;}
    $('#answer').disabled = true;
    $$('.meaning-choice').forEach(b => b.disabled = true);
    const heading = meaning ? (result.correct ? 'That’s the meaning.' : 'Not quite — here’s the meaning.') : result.correct ? (practice.correction ? 'Spelling corrected!' : 'Correct spelling!') : 'Let’s correct the spelling.';
    const detail = meaning ? `<p>${result.correct ? '' : 'Keep this meaning in mind. '}${escapeHtml(result.expected)}</p>` : result.correct ? `<p>${practice.hinted ? 'Try recalling it unaided next time.' : 'That’s right. A little more familiar.'}</p>${result.tip ? `<p class="feedback-tip">${escapeHtml(result.tip)}</p>` : ''}` : `${letterDiff(result.expected,result.answer)}<p>${escapeHtml(result.tip || 'Notice the highlighted letters, then try again.')}</p>`;
    practiceFeedback(result.correct ? 'correct' : 'incorrect',heading,detail);
    $('#answer').setAttribute('aria-invalid',String(!result.correct && !meaning));
    if (meaning) $$('.meaning-choice').forEach((button,i) => {
      button.classList.toggle('choice-correct',String(practice.choices[i].id) === String(word.id));
      button.classList.toggle('choice-incorrect',String(practice.choices[i].id) === String(practice.choice) && !result.correct);
    });
    $('#answer-submit').innerHTML = (practice.mode === 'drill' ? 'Type it again' : result.correct && TypewriterReview.quizDue(practice) && !meaning ? 'Meaning quiz' : result.correct || meaning ? (!practice.endless && practice.index + 1 >= practice.queue.length ? 'See my session' : 'Next word') : 'Practise the correction') + '<span class="enter-key" aria-hidden="true">Enter ↵</span>';
    if (practice.mode === 'drill' && practice.target && practice.correct >= practice.target) {finishPractice();}
  },$('#answer-submit'));
  answerBusy = false;
  if (practice === session && $('#practice-dialog').open) {
    $('#answer-form').setAttribute('aria-busy','false');
    if (!practice.feedback && !$('#practice-active').hidden) {
      $('#answer').disabled = false;$$('.meaning-choice').forEach(b => b.disabled = false);
      $('#answer-submit').hidden = meaning;
      $('#answer-submit').innerHTML = 'Check spelling' + icon('arrow');
    }
    if (!$('#practice-summary').hidden) $('#practice-summary button').focus();
    else if (practice.feedback) $('#answer-submit').focus();
    else if (meaning) $('.meaning-choice.selected, .meaning-choice')?.focus();
    else $('#answer').focus();
  }
}
async function advancePractice() {
  const session = practice;
  answerBusy = true;
  const button = $('#answer-submit');
  button.disabled = true;
  try {
    const quizzes = state.words.filter(w=>exerciseTypes(w,session.quizSettings).includes('meaning'));
    if (TypewriterReview.advance(session,quizzes)) {renderPractice();return;}
    if (!session.endless) {finishPractice();return;}
    button.textContent = 'Finding your next words…';
    await refresh();
    if (practice !== session || !$('#practice-dialog').open || $('#practice-active').hidden) return;
    const pool = reviewPool(session.scopeIds,true,session.quizSettings);
    if (TypewriterReview.replenish(session,pool.words,pool.quizzes)) renderPractice();
    else {finishPractice();toast('No more words are available for these exercises. Add material or choose other exercises in Settings.');}
  } catch (error) {
    if (practice === session && $('#practice-dialog').open && !$('#practice-active').hidden) {
      session.feedback = true;session.lastCorrect = true;
      practiceFeedback('error','Couldn’t load the next words',`<p>Your checked answers are saved. ${escapeHtml(error.message)} Press Enter to retry.</p>`);
      button.textContent = 'Retry · Enter';
    }
  } finally {
    answerBusy = false;button.disabled = false;
    if (practice === session && $('#practice-dialog').open && !$('#practice-active').hidden) {
      if (session.feedback) button.focus();
      else if (currentWord().exercise === 'meaning') $('.meaning-choice')?.focus();
      else $('#answer').focus();
    }
  }
}
function finishPractice() {
  stopPronunciation();
  if (!practice) return;
  const p = practice, minutes = Math.max(1,Math.round((Date.now()-p.started)/60000));
  $('#practice-active').hidden = true; $('#practice-summary').hidden = false;
  $('#practice-meter-fill').style.width = '100%';
  $('#practice-summary').innerHTML = `<div class="practice-summary"><div class="summary-mark">✳</div><span class="eyebrow">A LITTLE PROGRESS, MADE</span><h2>${p.mode === 'drill' ? 'A word, a little more familiar.' : 'You showed up for your words.'}</h2><p>${p.mode === 'drill' ? 'Your repetitions are saved. Come back later to check what you remember.' : 'Your answers are saved. Meaning scores and spelling recall are tracked separately.'}</p><div class="summary-stats"><div><strong>${p.attempts}</strong><span>${p.mode === 'drill' ? 'repetitions' : 'answers checked'}</span></div><div><strong>${p.correct}</strong><span>correct answers</span></div><div><strong>${minutes}</strong><span>minutes of focus</span></div></div><button class="button primary" data-action="close-practice">Back to my notebook${icon('arrow')}</button></div>`;
  $('#practice-summary button').focus();
  guarded(refresh);
}
function pronunciationUrl(word, preview = false) {
  return `/api/words/${word.id}/audio?accent=${state.settings.pronunciation_accent || 'uk'}&v=${word.audio_revision || word.version || 0}${preview ? '&preview=1' : ''}`;
}
function preparePronunciation(word) {
  const audio = $('#pronunciation');
  // Preload only recordings already checked or supplied by the user, without sound.
  if (!word.audio_flagged && (word.audio_eligible || word.audio_file)) {
    const url = pronunciationUrl(word);
    audio.preload = 'auto';
    if (audio.getAttribute('src') !== url) audio.src = url;
  } else if (audio.hasAttribute('src') && audio.getAttribute('src') !== pronunciationUrl(word)) {
    audio.removeAttribute('src');audio.load();
  }
}
function stopPronunciation(release = true) {
  audioSequence++;
  const audio = $('#pronunciation');
  audio.pause();
  if (release) {audio.removeAttribute('src');audio.load();}
}
async function listen(automatic = false) {
  if (!practice || $('#practice-active').hidden || currentWord().audio_flagged) return;
  const sequence = ++audioSequence, audio = $('#pronunciation');
  const url = pronunciationUrl(currentWord());
  audio.pause();
  // Play directly from our own server. Blob URLs were blocked by media-src 'self'.
  // Starting play before awaiting also keeps it attached to the user's click.
  // Cambridge downloads still pass through the Python server's configured proxy.
  if (audio.getAttribute('src') !== url) audio.src = url;
  else audio.currentTime = 0;
  $('#playback-status').textContent = 'Loading pronunciation…';
  try {await audio.play();if (sequence === audioSequence) $('#playback-status').textContent = 'Listening · Alt+P to replay';}
  catch (error) {
    if (sequence !== audioSequence || error.name === 'AbortError') return;
    $('#playback-status').textContent = 'Playback unavailable. Press Alt+P to try again, or skip this recording.';
    if (error.name === 'NotAllowedError') {$('#playback-status').textContent = 'Press Alt+P or Listen to allow playback. Your browser needs a playback gesture.';if (automatic) return;throw new Error('Press Listen to allow sound for Typewriter.');}
    // Recover the server's useful lookup/proxy error when a media request failed.
    const response = await fetch(url);
    if (sequence !== audioSequence) return;
    if (!response.ok) {const result = await response.json();const message = result.error || 'Pronunciation is unavailable.';$('#playback-status').textContent = message;throw new Error(message);}
    throw new Error('This pronunciation could not be played. Try another word or browser.');
  }
}
async function prepare(ids) {
  if (state.settings.preparation_method === 'offline') {openPreparation(ids);return;}
  if (state.settings.preparation_method === 'manual') {toast('Add meanings, sentences, and tips in the word editor.');return;}
  try {
    const result = await api('/enrichment/run','POST',ids ? {ids} : {});
    toast(result.message); await refresh();
  } catch (error) {
    pendingFailure = {key:'start:'+Date.now(),message:error.message,ids};showFailure();
  }
}

function renderWordAudio() {
  const word = state.words.find(w => w.id === editingId);
  if (!word) return;
  $('#audio-status').textContent = word.audio_flagged ? 'Flagged as incorrect. Excluded from audio-only exercises.' : word.audio_file ? `Your uploaded recording · ${word.audio_verified ? 'included in' : 'excluded from'} audio-only exercises.` : word.audio_verified ? 'Recording checked · included in audio-only exercises.' : 'Preview and check this recording before including it in audio-only exercises.';
  $('#audio-verified').checked = !!word.audio_verified && !word.audio_flagged;
  $('#audio-verified').disabled = !!word.audio_flagged;
  $('[data-action="restore-audio"]').hidden = !word.audio_flagged;
  $('[data-action="remove-audio"]').hidden = !word.audio_file;
}
async function changeWordAudio(data) {
  const result = await api(`/words/${editingId}/audio`,'PATCH',data);
  if (data.flagged) {$('#audio-preview').pause();$('#audio-preview').removeAttribute('src');$('#audio-preview').load();}
  await refresh();renderWordAudio();
  return result;
}
async function previewAudio() {
  const audio = $('#audio-preview');
  const url = pronunciationUrl(state.words.find(w=>w.id===editingId),true);
  if (audio.getAttribute('src') !== url) audio.src = url;
  else audio.currentTime = 0;
  $('#audio-status').textContent = 'Loading pronunciation…';
  try {await audio.play();await refresh();renderWordAudio();}
  catch (error) {
    const response = await fetch(audio.src);
    if (!response.ok) {const result = await response.json();throw new Error(result.error || 'Pronunciation unavailable.');}
    throw new Error('The recording could not be played. Check its format or upload a replacement.');
  }
}
async function uploadAudio() {
  const input = $('#audio-upload'), file = input.files[0];
  if (!file || !editingId) return;
  if (file.size > 5*1024*1024) {input.value='';throw new Error('Choose a recording no larger than 5 MB.');}
  $('#audio-preview').pause();$('#audio-preview').removeAttribute('src');$('#audio-preview').load();
  const data = new FormData();data.append('audio',file);
  const response = await fetch(`/api/words/${editingId}/audio`,{method:'POST',headers:{'X-Typewriter-Token':token},body:data});
  const result = await response.json();input.value='';
  if (!response.ok) throw new Error(result.error || 'Recording could not be saved.');
  await refresh();renderWordAudio();toast('Recording saved locally and enabled for audio-only exercises.');
}
async function removeUploadedAudio() {
  $('#audio-preview').pause();$('#audio-preview').removeAttribute('src');$('#audio-preview').load();
  await api(`/words/${editingId}/audio`,'DELETE');await refresh();renderWordAudio();
}
async function flagPracticeAudio() {
  if (!practice) return;
  const word = currentWord();
  stopPronunciation();
  await api(`/words/${word.id}/audio`,'PATCH',{flagged:true,verified:false});
  word.audio_flagged = true;word.audio_eligible = false;
  $('[data-action="listen"]', $('#practice-dialog')).hidden = true;$('#practice-audio-flag').hidden = true;
  $('#playback-status').textContent = 'Recording flagged. It will be excluded from audio-only exercises.';
  if (practice.mode === 'review' && word.exercise === 'audio') {
    practice.audioBlocked = true;practice.feedback = true;practice.lastCorrect = true;
    $('#answer').disabled = true;$('#answer-submit').textContent = 'Skip this word';$('#answer-submit').focus();
    practiceFeedback('skipped','Recording flagged', '<p>Press Enter to skip this recording.</p>');
  }
  await refresh();toast('Recording excluded. Upload a replacement in the word editor.');
}
async function skipAudio() {
  if (!practice || practice.mode !== 'review' || currentWord().exercise !== 'audio') return;
  if (answerBusy) return;
  practice.correction = false;
  await advancePractice();
}
function renderWordMeaning() {
  const word = state.words.find(w => w.id === editingId);
  $('#meaning-status').textContent = word.meaning_flagged ? 'Flagged for correction. Excluded from meaning quizzes and definition clues until fixed.' : word.distractors.length === 3 ? 'This word has LLM-generated quiz options.' : 'Prepare again to generate quiz options for this word.';
  $('[data-action="restore-meaning"]').hidden = !word.meaning_flagged;
  $('[data-action="flag-edit-meaning"]').hidden = !!word.meaning_flagged;
}
async function flagMeaning(id, flagged) {
  const locksPractice = practice && currentWord().id === id;
  if (locksPractice) answerBusy = true;
  try {
    const word = await api('/words/'+id+'/meaning','PATCH',{flagged});
    await refresh();
    if (editingId === id) renderWordMeaning();
    if (practice && currentWord().id === id) {
      const active = currentWord();Object.assign(active,word);
      $('#practice-meaning-flag').hidden = flagged;
      $('#practice-meaning').textContent = '';
      if (flagged && practice.mode === 'review' && ['meaning','definition'].includes(active.exercise)) {
        stopPronunciation();practice.feedback = true;practice.lastCorrect = true;
        $('#answer').disabled = true;$$('.meaning-choice').forEach(b=>b.disabled=true);
        $('#practice-clue').textContent = 'Marked for correction.';$('#meaning-options').hidden = true;
        $('#answer').removeAttribute('aria-invalid');
        practiceFeedback('skipped','Meaning flagged for correction','<p>Skip this question and keep practising.</p>');
        $('#answer-submit').hidden = false;$('#answer-submit').textContent = 'Continue · Enter';$('#answer-submit').focus();
      }
    }
    toast(flagged ? 'Meaning flagged. Prepare the queued word to correct it.' : 'Meaning flag cleared.');
  } finally {if (locksPractice) answerBusy = false;}
}

function openPreparation(ids, reEvaluate = false) {
  $('#prompt-reevaluate').checked = reEvaluate;
  $('#prompt-size').value = state.settings.offline_batch_size;
  $('#prompt-scope option[value="selected"]').disabled = !selected.size && !ids?.length;
  $('#prompt-scope').value = ids?.length || selected.size ? 'selected' : 'queue';
  $('#preparation-dialog').dataset.ids = ids ? JSON.stringify(ids) : '';
  updatePromptCount();
  $('#preparation-dialog').showModal();
}
function preparationIds() {
  if ($('#prompt-scope').value !== 'selected') return undefined;
  return $('#preparation-dialog').dataset.ids ? JSON.parse($('#preparation-dialog').dataset.ids) : [...selected];
}
function updatePromptCount() {
  const ids = preparationIds(), count = state.words.filter(w => ($('#prompt-reevaluate').checked || preparationPending(w)) && (!ids || ids.includes(w.id))).length;
  const size = Number($('#prompt-size').value);
  $('#prompt-scope option[value="queue"]').textContent = $('#prompt-reevaluate').checked ? 'All words in the notebook' : 'All words waiting for preparation';
  $('#prompt-count').textContent = `${count} word${count === 1 ? '' : 's'} · ${size>=1 && size<=100 ? Math.ceil(count/size) : '—'} prompt files`;
  $('[data-action="download-prompts"]').disabled = !count || !Number.isInteger(size) || size<1 || size>100;
}
async function downloadPrompts() {
  if (!$('#prompt-size').reportValidity()) return;
  const response = await fetch('/api/preparation/export',{method:'POST',headers:{'Content-Type':'application/json','X-Typewriter-Token':token},body:JSON.stringify({ids:preparationIds(),size:Number($('#prompt-size').value),re_evaluate:$('#prompt-reevaluate').checked})});
  if (!response.ok) {const error=await response.json();throw new Error(error.error || 'Prompts could not be exported.');}
  const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href=url;link.download=response.headers.get('Content-Disposition')?.match(/filename="?([^";]+)/)?.[1] || 'typewriter-preparation.zip';
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  await refresh();toast('Prompts downloaded. Give one Markdown file at a time to your LLM.');
}
function invalidatePreparedPreview() {
  preparedPreviewText = null;$('#apply-preparation').disabled=true;$('#preparation-preview').innerHTML='';
}
async function previewPreparation() {
  invalidatePreparedPreview();
  const text = $('#prepared-response').value, result = await api('/preparation/preview','POST',{text});
  // Do not apply a reply changed while validation was in flight.
  if ($('#prepared-response').value !== text) return;
  preparedPreviewText = text;
  $('#apply-preparation').disabled = !result.words.some(w=>w.fill.length || w.replace.length);
  $('#preparation-preview').innerHTML = `<p class="info-note">${result.words.length} entries · ${result.missing} missing from the batch. Review additions and replacements below. Newer edits will be kept.</p>` + result.words.map(w=>`<div class="prepared-entry"><strong>${escapeHtml(w.word)}</strong><span class="field-note">${w.removed ? 'Word removed from notebook; will be skipped.' : w.stale ? 'Changed since export or already applied; will be kept. Export a new prompt to re-evaluate.' : w.replace.length ? 'Will replace: '+escapeHtml(w.replace.join(', ')) : w.fill.length ? 'Will add: '+escapeHtml(w.fill.join(', ')) : 'Already filled; will be kept.'}</span>${w.replace.length ? `<p class="muted small">Saved meaning: ${escapeHtml(w.previous.definition || 'Empty')}</p>${w.previous.sentence !== undefined ? `<p class="muted small">Saved sentence: ${escapeHtml(w.previous.sentence || 'Empty')}</p><p class="muted small">Saved tip: ${escapeHtml(w.previous.tip || 'Empty')}</p>` : ''}` : ''}<p>${escapeHtml(w.definition)}</p><p>${escapeHtml(w.sentence)}</p><p class="muted small">${escapeHtml(w.tip)}</p>${w.distractors ? `<p class="field-note">Quiz options: ${w.distractors.map(escapeHtml).join(' · ')}</p>` : ''}</div>`).join('');
}
async function applyPreparation() {
  if (!preparedPreviewText || preparedPreviewText !== $('#prepared-response').value) throw new Error('Preview this reply before importing it.');
  const result = await api('/preparation/import','POST',{text:preparedPreviewText});
  invalidatePreparedPreview();await refresh();updatePromptCount();
  toast(`${result.updated} words updated · ${result.skipped} kept or removed · ${result.missing} missing from this reply.`);
  $('#preparation-preview').textContent = 'Reply imported. You can preview the next batch here.';
}
async function refreshModels() {
  $('#model-note').textContent = 'Checking available model IDs…';
  try {
    const result = await api('/models/refresh','POST',{});
    $('#gemini-models').innerHTML = result.models.map(m=>`<option value="${escapeHtml(m)}"></option>`).join('');
    $('#model-note').textContent = `${result.models.length} available text models loaded. Choose an exact ID from the suggestions.`;
  } catch (error) {$('#model-note').textContent = 'Model list unavailable. The API-free workflow is still available.';throw error;}
}
$('#audio-upload').addEventListener('change',()=>guarded(uploadAudio));
$('#audio-verified').addEventListener('change',event=>guarded(()=>changeWordAudio({verified:event.target.checked})));
$('#prompt-size').addEventListener('input',updatePromptCount);
$('#prompt-scope').addEventListener('change',updatePromptCount);
$('#prepared-response').addEventListener('input',invalidatePreparedPreview);
$('#prepared-file').addEventListener('change',event=>guarded(async()=>{
  const file=event.target.files[0];if (!file) return;
  if (file.size>2*1024*1024) throw new Error('Choose a reply smaller than 2 MB.');
  $('#prepared-response').value=await file.text();invalidatePreparedPreview();event.target.value='';
}));

const actions = {
  add:() => openWord(), starter:addStarter, review:() => startReview(), 'review-endless':() => startReview(undefined,true), 'choose-drill':() => chooseDrill(),
  'prepare-all':() => prepare(), 'prepare-selected':() => prepare([...selected]),
  'prepare-again':() => openPreparation([...selected],true),
  'failure-fallback':useAnotherLLM,
  'failure-dismiss':() => {pendingFailure=null;$('#failure-dialog').close();},
  'flag-practice-meaning':() => {if (!answerBusy) return flagMeaning(currentWord().id,true);},
  'flag-edit-meaning':() => flagMeaning(editingId,true), 'restore-meaning':() => flagMeaning(editingId,false),
  'review-selected':() => startReview([...selected]), 'review-selected-endless':() => startReview([...selected],true), 'clear-selection':() => {selected.clear();renderLibrary();},
  lookup:lookupWord,
  'test-network':async () => {await saveSettings();$('#network-result').textContent = 'Testing…';try {const r = await api('/network/test','POST',{});$('#network-result').textContent = r.message;toast(r.message);} catch(error) {$('#network-result').textContent = 'Connection failed.';throw error;}},
  'save-keys':async () => {const result = await api('/keys','PUT',{keys:$('#api-keys').value});$('#api-keys').value = '';await refresh();toast(`${result.count} keys saved locally.`);},
  import:() => $('#import-file').click(),
  'delete-word':() => {deletingId = editingId;$('#confirm-message').textContent = `This removes “${state.words.find(w => w.id === editingId).word}” and its practice history from this notebook.`;$('#confirm-dialog').showModal();},
  hint:() => {if (!practice) return;practice.hinted = true;$('#practice-word').textContent = currentWord().word;$('#hint-button').hidden = true;$('#practice-label').textContent = 'LOOK, REMEMBER, THEN TYPE';$('#answer').focus();},
  listen:() => listen(),
  'offline-preparation':() => openPreparation(),
  'download-prompts':downloadPrompts, 'preview-preparation':previewPreparation, 'apply-preparation':applyPreparation,
  'refresh-models':refreshModels, 'preview-audio':previewAudio,
  'flag-edit-audio':() => changeWordAudio({flagged:true,verified:false}),
  'restore-audio':() => changeWordAudio({flagged:false,verified:false}),
  'remove-audio':removeUploadedAudio, 'flag-practice-audio':flagPracticeAudio,
  'skip-audio':skipAudio,
  'finish-practice':() => {if ($('#practice-summary').hidden) finishPractice();else actions['close-practice']();},
  'close-practice':() => {stopPronunciation();$('#practice-dialog').close();practice = null;},
};
document.addEventListener('click',event => {
  const choice = event.target.closest('[data-meaning-choice]');if (choice) {selectMeaning(Number(choice.dataset.meaningChoice));return;}
  const page = event.target.closest('[data-page]');if (page) {navigate(page.dataset.page);return;}
  const close = event.target.closest('[data-close]');if (close) {if (close.dataset.close === 'word-dialog') {$('#audio-preview').pause();$('#audio-preview').removeAttribute('src');$('#audio-preview').load();}$('#'+close.dataset.close).close();return;}
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
$('#drill-search').addEventListener('input',filterDrillWords);
$('#drill-search').addEventListener('focus',filterDrillWords);
$('#drill-search').addEventListener('click',renderDrillOptions);
$('#drill-search').addEventListener('keydown',event => {
  if (event.isComposing) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if ($('#drill-options').hidden) filterDrillWords();
    else {drillHighlight = (drillHighlight + (event.key === 'ArrowDown' ? 1 : -1) + drillMatches.length) % (drillMatches.length || 1);renderDrillOptions();}
  } else if (event.key === 'Tab' && !event.shiftKey && $('#drill-completion').textContent) {
    event.preventDefault();acceptDrillWord();
  } else if (event.key === 'Enter' && !$('#drill-options').hidden) {
    event.preventDefault();acceptDrillWord();
  } else if (event.key === 'Escape' && !$('#drill-options').hidden) {
    event.preventDefault();event.stopPropagation();showDrillOptions(false);$('#drill-completion').textContent = '';
  }
});
$('#drill-options').addEventListener('mousedown',event => {
  const option = event.target.closest('[data-drill-option]');
  if (option) {event.preventDefault();drillHighlight = Number(option.dataset.drillOption);acceptDrillWord();}
});
$('#drill-toggle').addEventListener('click',() => {const open = $('#drill-options').hidden;$('#drill-search').focus();if (open) filterDrillWords();else showDrillOptions(false);});
$('#drill-search').addEventListener('blur',() => {showDrillOptions(false);$('#drill-completion').textContent = '';});
$('#practice-dialog').addEventListener('keydown',event => {
  if (event.isComposing || $('#practice-active').hidden) return;
  if (event.altKey && event.code === 'KeyP') {event.preventDefault();if (!event.repeat) guarded(() => listen());return;}
  if (/^[1-4]$/.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && practice?.mode === 'review' && currentWord().exercise === 'meaning' && !practice.feedback) {event.preventDefault();if (!event.repeat) selectMeaning(Number(event.key)-1);return;}
  if (event.key === 'Enter' && practice?.mode === 'review' && currentWord().exercise === 'meaning' && !practice.feedback) {event.preventDefault();return;}
  if (event.key !== 'Enter') return;
  if (event.repeat) {event.preventDefault();return;}
  if (answerBusy) {event.preventDefault();return;}
  if (practice?.feedback) {event.preventDefault();answerSubmit(event);}
});
$('#answer-form').addEventListener('submit',answerSubmit);
$('#dictionary-sense').addEventListener('change',applyDictionarySense);
$('#dictionary-example').addEventListener('change',() => {$('#word-form').elements.sentence.value = $('#dictionary-example').value;});
$('#word-form').elements.word.addEventListener('input',() => {dictionaryData = null;dictionaryApplied = false;$('#dictionary-choices').hidden = true;});
$('#practice-show').addEventListener('change',event => {if (practice) {practice.show = event.target.checked;$('#practice-word').textContent = practice.show ? currentWord().word : '';}});
$('#settings-form').elements.preparation_method.addEventListener('change',event => {$('#settings-form').elements.auto_ai.disabled = event.target.value !== 'api';});
$('#settings-form').addEventListener('submit',event => {event.preventDefault();guarded(async () => {await saveSettings();await refresh();toast('Settings saved.');},$('#settings-form button[type=submit]'));});
$('#confirm-delete').addEventListener('click',() => guarded(async () => {await api('/words/'+deletingId,'DELETE');$('#confirm-dialog').close();$('#word-dialog').close();await refresh();toast('Word removed.');},$('#confirm-delete')));
$('#import-file').addEventListener('change',event => guarded(async () => {const file = event.target.files[0];if (!file) return;if (file.size > 32*1024*1024) throw new Error('Choose a backup smaller than 32 MB.');let backup;try {backup=JSON.parse(await file.text());} catch {throw new Error('That file is not a valid JSON backup.');}const r=await api('/import','POST',backup);await refresh();toast(`${r.added} words imported. ${r.skipped} existing words kept.`);event.target.value='';}));
$('#word-dialog').addEventListener('close',() => {$('#audio-preview').pause();$('#audio-preview').removeAttribute('src');$('#audio-preview').load();});
$('#practice-dialog').addEventListener('cancel',event => {event.preventDefault();if ($('#practice-summary').hidden) finishPractice();else actions['close-practice']();});
window.addEventListener('hashchange',() => navigate(location.hash.slice(1)));
$$('dialog').forEach(dialog => dialog.addEventListener('close',() => {
  if ($('#toast').parentElement === dialog) {$('#toast').hidden = true;document.body.append($('#toast'));}
  setTimeout(showFailure,0);
}));
$('#failure-dialog').addEventListener('cancel',() => {pendingFailure=null;});
$('#prompt-reevaluate').addEventListener('change',updatePromptCount);
['quiz_interval_mode','quiz_interval_fixed','quiz_interval_min','quiz_interval_max','meaning_enabled'].forEach(name => $('#settings-form').elements[name].addEventListener('input',event=>updateQuizRhythm(event.target)));
hydrateIcons();
$('#date-label').textContent = new Date().toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
guarded(async () => {await refresh();navigate(location.hash.slice(1) || 'today');});
setInterval(async () => {
  if (!state || document.hidden) return;
  try {const job = await api('/enrichment');if (job.busy !== state.enrichment.busy || job.done !== state.enrichment.done || job.pending !== state.enrichment.pending || job.message !== state.enrichment.message || job.status !== state.enrichment.status || job.id !== state.enrichment.id) {await refresh();}else {state.enrichment = job;renderQueue();renderKeys();}}catch { /* Keep the notebook usable during a temporary disconnect. */ }
},4000);
