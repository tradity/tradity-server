// Tradity.de Server
// Copyright (C) 2016 Tradity.de Tech Team <tech@tradity.de>

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version. 

// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.

// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.

"use strict";

const _ = require('lodash');
const assert = require('assert');
const buscomponent = require('./stbuscomponent.js');
const debug = require('debug')('sotrade:questionnaires');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

/**
 * Provides methods for sending questionnaires to the
 * client and receiving the results.
 * 
 * @public
 * @module questionnaires
 */

/**
 * Main object of the {@link module:questionnaires} module
 * @public
 * @constructor module:questionnaires~Questionnaires
 * @augments module:stbuscomponent~STBusComponent
 */
class Questionnaires extends buscomponent.BusComponent {
  constructor() {
    super();
  }
}

/**
 * Return a list of all questionnaires which have not been answered by
 * the current user.
 * 
 * @return {object} Returns with <code>list-questionnaires-success</code>
 *                  or a common error code.
 * 
 * @loginignore
 * @function c2s~list-questionnaires
 */
Questionnaires.prototype.listQuestionnaires = buscomponent.provideQT('client-list-questionnaires', function(query, ctx) {
  const questionnaires = this.loadQuestionnaires(ctx);
  const uid = (ctx.user && ctx.user.uid) || null;
  
  return Promise.all([
    questionnaires,
    ctx.query('SELECT questionnaire_id FROM qn_questionnaires ' +
      'WHERE (display_after  IS NULL OR display_after  <= UNIX_TIMESTAMP()) AND' +
      '      (display_before IS NULL OR display_before >= UNIX_TIMESTAMP()) ' +
      (uid === null ? '' :
        'AND (SELECT COUNT(*) FROM qn_result_sets ' + 
        'WHERE uid = ? AND qn_result_sets.questionnaire_id = qn_questionnaires.questionnaire_id) = 0 '
      ), uid === null ? [] : [uid])
    ]).then(spread(function(questionnaires, res) {
    const ids = _.pluck(res, 'questionnaire_id');
    
    return {
      code: 'list-questionnaires-success',
      questionnaires: _.pick(questionnaires, ids),
      isPersonalized: uid !== null
    };
  }));
});

/**
 * Save the results of a filled questionnaire.
 * 
 * @param {int} query.questionnaire  The numerical id of the filled questionnaire.
 * 
 * @return {object} Returns with <code>save-questionnaire-success</code>
 *                  or a common error code.
 * 
 * @noreadonly
 * @function c2s~save-questionnaire
 */
Questionnaires.prototype.saveQuestionnaire = buscomponent.provideTXQT('client-save-questionnaire', function(query, ctx) {
  const questionnaireId = parseInt(query.questionnaire);
  const fill_time = parseInt(query.fill_time);
  if (questionnaireId !== questionnaireId || fill_time !== fill_time) {
    throw new this.FormatError();
  }
  
  query.fill_language = String(query.fill_language);
  
  if (!query.results || !query.results.length) {
    throw new this.FormatError();
  }
  
  const resultsQuery = [];
  const resultsArguments = [];
  
  return this.loadQuestionnaires(ctx).then(questionnaires => {
    if (!questionnaires.hasOwnProperty(questionnaireId)) {
      throw new this.SoTradeClientError('save-questionnaire-unknown-questionnaire');
    }
    
    const questionnaire = questionnaires[questionnaireId][query.fill_language];
    
    if (!questionnaire) {
      throw new this.SoTradeClientError('save-questionnaire-unknown-questionnaire');
    }
    
    assert.ok(questionnaire.questionnaire_id);
    
    const answeredQuestions = _.pluck(query.results, 'question');
    const availableQuestions = _.pluck(questionnaire.questions, 'question_id');
    
    if (_.xor(answeredQuestions, availableQuestions).length > 0) {
      throw new this.SoTradeClientError('save-questionnaire-incomplete');
    }
    
    for (let i = 0; i < query.results.length; ++i) {
      const answers = query.results[i].answers;
      const question = questionnaire.questions.filter(qn => {
        return qn.question_id === query.results[i].question;
      })[0];
      
      assert.ok(question);
      
      if (!answers || (answers.length !== 1 && !question.question_multiple_answers)) {
        throw new this.SoTradeClientError('save-questionnaire-invalid',
          'Invalid number of answers for question ' + question.question_id +
          ' (' + JSON.stringify(question) + ')');
      }
      
      const chosenAnswers = _.pluck(answers, 'answer');
      const availableAnswers = _.pluck(question.answers, 'answer_id');
      
      if (_.difference(chosenAnswers, availableAnswers).length > 0) {
        throw new this.SoTradeClientError('save-questionnaire-invalid',
          'Invalid answer(s) for question ' + question.question_id + ': ' +
          JSON.stringify(_.difference(chosenAnswers, availableAnswers)) +
          ' (' + JSON.stringify(question) + ')');
      }
      
      for (let j = 0; j < answers.length; ++j) {
        resultsQuery.push('(%resultSetID%,?,?,?)');
        resultsArguments.push(question.question_id, answers[j].answer, answers[j].answer_freetext || null);
      }
    }
    
    return ctx.query('INSERT INTO qn_result_sets (questionnaire_id, uid, submission_time, fill_time, fill_language)' + 
      'VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?)',
      [questionnaire.questionnaire_id, ctx.user.uid, fill_time, query.fill_language]);
  }).then(res => {
    const resultSetID = parseInt(res.insertId);
    
    return ctx.query('INSERT INTO qn_results (result_set_id, question_id, answer_id, answer_text) VALUES ' +
      resultsQuery.join(',').replace(/%resultSetID%/g, resultSetID), resultsArguments);
  }).then(() => {
    return { code: 'save-questionnaire-success' };
  });
});

/**
 * Perform the initial load of all questionnaires.
 * 
 * @return {object} A Promise for a list of questionnaires.
 * @function module:questionnaires~Questionnaires#loadQuestionnaires
 */
Questionnaires.prototype.loadQuestionnaires = function(ctx) {
  debug('loadQuestionnaires', !!this.questionnaires);
  if (this.questionnaires) {
    return this.questionnaires;
  }
  
  let loadQuestionnaire, loadQuestion, loadAnswer, groupByLanguage;
  
  groupByLanguage = listWithLangAttribute => {
    const ret = _.groupBy(listWithLangAttribute, 'language');
    return _.mapValues(ret, list => _.omit(list[0], 'language'));
  };
  
  loadQuestionnaire = function(questionnaire) {
    return Promise.all([
      ctx.query('SELECT language, qtext FROM qn_questionnaire_text WHERE questionnaire_id = ?', [questionnaire.questionnaire_id]).then(groupByLanguage),
      ctx.query('SELECT qn_questions.question_id, question_multiple_answers, `order` ' + 
        'FROM qn_questions_questionnaires AS qlist ' +
        'JOIN qn_questions ON qn_questions.question_id = qlist.question_id ' +
        'WHERE qlist.questionnaire_id = ? ORDER BY `order` ASC', [questionnaire.questionnaire_id])
        .then(res => {
        return Promise.all(res.map(loadQuestion));
      })
    ]).then(spread((texts, questions) => {
      return _.mapValues(texts, (entry, lang) => {
        return _.extend(entry, questionnaire, {
          questions: _.pluck(questions, lang)
        });
      });
    })).then(questionnaireObject => {
      questionnaireObject.questionnaire_id = questionnaire.questionnaire_id;
      return questionnaireObject;
    });
  };
  
  loadQuestion = function(question) {
    return Promise.all([
      ctx.query('SELECT language, qtext  FROM qn_questions_texts WHERE question_id = ?', [question.question_id]).then(groupByLanguage),
      ctx.query('SELECT qn_answers.answer_id, answer_freetext, `order` ' +
        'FROM qn_questions_answers AS alist ' +
        'JOIN qn_answers ON qn_answers.answer_id = alist.answer_id ' +
        'WHERE alist.question_id = ? ORDER BY `order` ASC', [question.question_id]).then(res => {
        return Promise.all(res.map(loadAnswer));
      })
    ]).then(spread((texts, answers) => {
      return _.mapValues(texts, (entry, lang) => {
        return _.extend(entry, question, {
          answers: _.pluck(answers, lang)
        });
      });
    }));
  };
  
  loadAnswer = function(answer) {
    return ctx.query('SELECT language, atext FROM qn_answer_texts WHERE answer_id = ?', [answer.answer_id]).then(groupByLanguage)
    .then(texts => {
      return _.mapValues(texts, entry => {
        return _.extend(entry, answer);
      });
    });
  };
  
  return this.questionnaires = ctx.query('SELECT * FROM qn_questionnaires').then(res => {
    return Promise.all(res.map(loadQuestionnaire));
  }).then(questionnaires => {
    debug('Loaded questionnaires', questionnaires.length);
    
    return _.mapValues(_.groupBy(questionnaires, 'questionnaire_id'), 0);
  });
};

exports.Questionnaires = Questionnaires;
