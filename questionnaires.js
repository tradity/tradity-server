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
const api = require('./api.js');
const debug = require('debug')('sotrade:questionnaires');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

class QuestionnairesList extends api.Requestable {
  constructor() {
    super({
      url: '/questionnaires',
      methods: ['GET'],
      returns: [
        { code: 200 }
      ],
      requiredLogin: false,
      description: 'Return a list of all questionnaires which have not been answered by the current user.',
      depends: [QuestionnaireDatabase]
    });
  }
  
  handle(query, ctx) {
    const questionnaires = this.load(QuestionnaireDatabase).loadQuestionnaires(ctx);
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
      ]).then(spread((questionnaires, res) => {
      const ids = _.map(res, 'questionnaire_id');
      
      return {
        code: 200,
        data: {
          questionnaires: _.pick(questionnaires, ids),
          isPersonalized: uid !== null
        }
      };
    }));
  }
}

class QuestionnaireSave extends api.Requestable {
  constructor() {
    super({
      url: '/questionnaire/:questionnaire',
      methods: ['POST'],
      returns: [
        { code: 204 },
        { code: 404, identifier: 'unknown-questionnaire' },
        { code: 403, identifier: 'incomplete' },
        { code: 403, identifier: 'invalid-answers' }
      ],
      schema: {
        type: 'object',
        properties: {
          questionnaire: {
            type: 'string',
            description: 'The numerical id of the filled questionnaire.'
          },
          fill_time: { type: 'integer' },
          fill_language: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'integer' },
                answers: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      answer: { type: 'integer' },
                      text: { type: 'string' }
                    },
                    required: ['answer']
                  },
                  uniqueItems: true
                }
              },
              required: ['question', 'answers']
            },
            uniqueItems: true
          }
        },
        required: ['questionnaire', 'fill_time', 'fill_language', 'results']
      },
      transactional: true,
      description: 'Save the results of a filled questionnaire.',
      depends: [QuestionnaireDatabase]
    });
  }
  
  handle(query, ctx) {
    const resultsQuery = [];
    const resultsArguments = [];
    
    return this.load(QuestionnaireDatabase)
      .loadQuestionnaires(ctx).then(questionnaires => {
      if (!questionnaires.hasOwnProperty(questionnaireId)) {
        throw new this.ClientError('unknown-questionnaire');
      }
      
      const questionnaire = questionnaires[questionnaireId][query.fill_language];
      
      if (!questionnaire) {
        throw new this.ClientError('unknown-questionnaire');
      }
      
      assert.ok(questionnaire.questionnaire_id);
      
      const answeredQuestions = _.map(query.results, 'question');
      const availableQuestions = _.map(questionnaire.questions, 'question_id');
      
      if (_.xor(answeredQuestions, availableQuestions).length > 0) {
        throw new this.ClientError('incomplete');
      }
      
      for (let i = 0; i < query.results.length; ++i) {
        const answers = query.results[i].answers;
        const question = questionnaire.questions.filter(qn => { // jshint ignore:line
          return qn.question_id === query.results[i].question;
        })[0];
        
        assert.ok(question);
        
        if (!answers || (answers.length !== 1 && !question.question_multiple_answers)) {
          throw new this.ClientError('invalid-answers',
            'Invalid number of answers for question ' + question.question_id +
            ' (' + JSON.stringify(question) + ')');
        }
        
        const chosenAnswers = _.map(answers, 'answer');
        const availableAnswers = _.map(question.answers, 'answer_id');
        
        if (_.difference(chosenAnswers, availableAnswers).length > 0) {
          throw new this.ClientError('invalid-answers',
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
      return { code: 204 };
    });
  }
}

class QuestionnaireDatabase extends api.Component {
  constructor() {
    super({
      description: 'Perform the initial load of all questionnaires.',
    });
  }
  
  loadQuestionnaires(ctx) {
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
            questions: _.map(questions, lang)
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
            answers: _.map(answers, lang)
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
  }
}

exports.components = [
  QuestionnaireSave,
  QuestionnairesList
];
