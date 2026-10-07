const assert = require('node:assert/strict');
const rules = require('../static/review.js');
const fixed = {quiz_interval_mode:'fixed',quiz_interval_min:5,quiz_interval_max:5};
const range = {quiz_interval_mode:'range',quiz_interval_min:2,quiz_interval_max:7};
const spelling = () => Array.from({length:10},(_,i)=>({id:i+1,exercise:'sentence'}));
const quizzes = [{id:1,meaning_priority:4},{id:2,meaning_priority:2}];

assert.equal(rules.gap(range,()=>0),2);
assert.equal(rules.gap(range,()=>0.999999),7);
assert.equal(rules.gap(fixed,()=>0),5);
let session = rules.create(spelling(),quizzes,fixed), sequence = [];
do {
  const word = session.queue[session.index];
  sequence.push(word.exercise);
  if(word.exercise !== 'meaning') {
    rules.recordSpelling(session,word);
    const count = session.wordsSinceQuiz;
    rules.recordSpelling(session,word); // Another correction cannot count twice.
    assert.equal(session.wordsSinceQuiz,count);
  }
} while(rules.advance(session,quizzes));
assert.deepEqual(sequence,['sentence','sentence','sentence','sentence','sentence','meaning','sentence','sentence','sentence','sentence','sentence','meaning']);
assert.equal(session.spellingsDone,10);
assert.equal(session.queue.filter(w=>w.exercise!=='meaning').length,10);
assert.deepEqual(session.queue.filter(w=>w.exercise==='meaning').map(w=>w.id),[1,2]);

session=rules.create(spelling(),quizzes,range,()=>0);
for(let i=0;i<2;i++) {rules.recordSpelling(session,session.queue[session.index]);rules.advance(session,quizzes,()=>0.999999);}
assert.equal(session.queue[session.index].exercise,'meaning');
assert.equal(session.quizGap,7); // A fresh draw, not the initial gap reused.
rules.advance(session,quizzes);
for(let i=0;i<6;i++) {rules.recordSpelling(session,session.queue[session.index]);rules.advance(session,quizzes);}
assert.notEqual(session.queue[session.index].exercise,'meaning');
rules.recordSpelling(session,session.queue[session.index]);rules.advance(session,quizzes);
assert.equal(session.queue[session.index].exercise,'meaning');

session=rules.create(spelling(),quizzes,{...fixed,quiz_interval_min:1,quiz_interval_max:1});
rules.advance(session,quizzes); // A skipped question never recorded a spelling.
assert.notEqual(session.queue[session.index].exercise,'meaning');
rules.recordSpelling(session,session.queue[session.index]);rules.advance(session,[]); // Flagged/deleted quiz words disappear.
assert.notEqual(session.queue[session.index].exercise,'meaning');

session=rules.create([],quizzes,fixed);
assert(session.meaningOnly);
assert(session.queue.every(w=>w.exercise==='meaning'));
rules.advance(session,quizzes);
assert.equal(session.queue.length,2);
// Endless sessions preserve cadence across refills and keep only a small active set.
session=rules.create(spelling(),quizzes,{...fixed,quiz_interval_min:7,quiz_interval_max:7},Math.random,{endless:true});
let spellings=0, quizPositions=[], refills=0;
while(spellings<30) {
  const word=session.queue[session.index];
  if(word.exercise==='meaning') quizPositions.push(spellings);
  else {rules.recordSpelling(session,word);spellings++;}
  if(!rules.advance(session,quizzes)) {
    assert(session.needsRefill);
    const completed=session.questionsDone;
    assert.equal(rules.advance(session,quizzes),false); // Retrying a failed refresh is idempotent.
    assert.equal(session.questionsDone,completed);
    assert.equal(rules.replenish(session,[],[]),false);
    assert(session.needsRefill);
    assert(rules.replenish(session,spelling(),quizzes));
    refills++;
    assert.equal(session.wordsSinceQuiz,spellings%7);
  }
  assert(session.queue.length<=12);
}
assert.deepEqual(quizPositions,[7,14,21,28]);
assert.equal(refills,3);
assert.equal(session.spellingsDone,30);

// A single selected word works repeatedly without stale per-question flags.
session=rules.create(spelling().slice(0,1),[],fixed,Math.random,{endless:true});
for(let i=0;i<4;i++) {
  rules.recordSpelling(session,session.queue[0]);
  assert.equal(rules.advance(session,[]),false);
  assert(rules.replenish(session,spelling().slice(0,1),[]));
}
assert.equal(session.wordsSinceQuiz,4);
assert.equal(session.questionsDone,4);
assert.equal(session.queue.length,1);

// Meaning-only endless reviews also refill and avoid immediate repeats.
session=rules.create([],quizzes,fixed,Math.random,{endless:true});
rules.advance(session,quizzes);rules.advance(session,quizzes);
assert(rules.replenish(session,[],[quizzes[1],quizzes[0]]));
assert.equal(session.queue[0].id,quizzes[0].id);
assert.equal(session.questionsDone,2);
assert(session.meaningOnly);
assert.equal(rules.replenish(rules.create(spelling(),quizzes,fixed),spelling(),quizzes),false);
console.log('Review checks passed: fixed/random rhythm, correction and skip counting, unavailable words, endless cadence across refills, safe retries, bounded queues, one-word repeats, and meaning-only sessions.');
