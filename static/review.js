/* Review rules with injectable randomness for repeatable Node checks. */
(function (root) {
  'use strict';
  function gap(settings, random = Math.random) {
    const minimum = settings.quiz_interval_min ?? 5;
    const maximum = settings.quiz_interval_max ?? minimum;
    return settings.quiz_interval_mode === 'range' ? minimum + Math.floor(random() * (maximum - minimum + 1)) : minimum;
  }
  function create(spelling, quizzes, settings, random = Math.random, options = {}) {
    return {
      queue: spelling.length ? spelling.map(word => ({...word,spellingRecorded:false})) : quizzes.map(word => ({...word,exercise:'meaning'})),
      index:0, quizIds:quizzes.map(word => word.id), usedQuizIds:[],
      meaningOnly:!spelling.length, spellingTotal:spelling.length, spellingsDone:0,
      endless:!!options.endless, needsRefill:false, questionsDone:0, lastWordId:null,
      wordsSinceQuiz:0, quizGap:gap(settings,random), quizSettings:{...settings},
    };
  }
  function recordSpelling(session, word) {
    if (word.spellingRecorded) return;
    word.spellingRecorded = true;
    session.wordsSinceQuiz++;
  }
  function quizDue(session) {
    return !session.meaningOnly && session.quizIds.length > 0 && session.wordsSinceQuiz >= session.quizGap;
  }
  function advance(session, available, random = Math.random) {
    if (session.needsRefill) return false; // A failed refresh can be retried safely.
    const word = session.queue[session.index];
    session.lastWordId = word.id;
    session.questionsDone++;
    if (word.exercise !== 'meaning') {
      session.spellingsDone++;
      if (quizDue(session)) {
        const candidates = available.filter(w => session.quizIds.includes(w.id)).sort((a,b) => (b.meaning_priority ?? 0) - (a.meaning_priority ?? 0));
        const next = candidates.find(w => !session.usedQuizIds.includes(w.id)) || candidates[0];
        if (next) {
          if (session.usedQuizIds.includes(next.id)) session.usedQuizIds = [];
          session.usedQuizIds.push(next.id);
          session.queue.splice(session.index+1,0,{...next,exercise:'meaning'});
          session.wordsSinceQuiz = 0;
          session.quizGap = gap(session.quizSettings,random);
        }
      }
    }
    if (session.endless && session.index + 1 >= session.queue.length) {
      session.needsRefill = true;
      return false;
    }
    session.index++;
    return session.index < session.queue.length;
  }
  function replenish(session, spelling, quizzes) {
    if (!session.endless || !session.needsRefill) return false;
    const words = spelling.length ? spelling.map(word=>({...word,spellingRecorded:false})) : quizzes.map(word=>({...word,exercise:'meaning'}));
    // Avoid an immediate repeat when another word is available.
    if (words.length > 1 && words[0].id === session.lastWordId) words.push(words.shift());
    if (!words.length) return false;
    session.queue = words;
    session.index = 0;
    session.needsRefill = false;
    session.meaningOnly = !spelling.length;
    session.quizIds = quizzes.map(word=>word.id);
    session.usedQuizIds = session.usedQuizIds.filter(id=>session.quizIds.includes(id));
    return true;
  }
  const rules = {gap,create,recordSpelling,quizDue,advance,replenish};
  if (typeof module !== 'undefined' && module.exports) module.exports = rules;
  else root.TypewriterReview = rules;
})(globalThis);
