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
console.log('Review checks passed: fixed/random gaps, fresh draws, extra quizzes, correction/skip counting, unavailable words, and meaning-only sessions.');
