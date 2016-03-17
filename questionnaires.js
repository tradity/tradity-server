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

const assert = require('assert');
const api = require('./api.js');
const debug = require('debug')('sotrade:questionnaires');
const promiseUtil = require('./lib/promise-util.js');
const spread = promiseUtil.spread;

class QuestionnaireDatabase extends api.Component {
  constructor() {
    super({
      local: true,
      description: 'Perform the initial load of all questionnaires.'
    });
  }
  
  loadQuestionnaires(ctx) {
    debug('loadQuestionnaires', !!this.questionnaires);
    if (this.questionnaires) {
      return this.questionnaires;
    }
    
    let loadQuestionnaire, loadQuestion, loadAnswer;
    
    const groupByLanguage = listWithLangAttribute => {
      return Object.assign(
        ...listWithLangAttribute.map(entry => ({
          [entry.language]: Object.assign({}, entry, { language: undefined })
        }))
      );
    };
    
    loadQuestionnaire = questionnaire => {
      return Promise.all([
        ctx.query('SELECT language, qtext FROM qn_questionnaire_text WHERE questionnaire_id = ?', [questionnaire.questionnaire_id])
          .then(groupByLanguage),
        ctx.query('SELECT qn_questions.question_id, question_multiple_answers, `order` ' + 
          'FROM qn_questions_questionnaires AS qlist ' +
          'JOIN qn_questions ON qn_questions.question_id = qlist.question_id ' +
          'WHERE qlist.questionnaire_id = ? ORDER BY `order` ASC', [questionnaire.questionnaire_id])
          .then(res => {
          return Promise.all(res.map(loadQuestion));
        })
      ]).then(spread((texts, questions) => {
        return Object.assign(
          ...Object.keys(texts).map(lang => ({
            [lang]: Object.assign({}, texts[lang], questionnaire, {
              questions: questions.map(question => question[lang])
            })
          })).concat([{
            questionnaire_id: questionnaire.questionnaire_id
          }])
        );
      }));
    };
    
    loadQuestion = question => {
      return Promise.all([
        ctx.query('SELECT language, qtext  FROM qn_questions_texts WHERE question_id = ?', [question.question_id]).then(groupByLanguage),
        ctx.query('SELECT qn_answers.answer_id, answer_freetext, `order` ' +
          'FROM qn_questions_answers AS alist ' +
          'JOIN qn_answers ON qn_answers.answer_id = alist.answer_id ' +
          'WHERE alist.question_id = ? ORDER BY `order` ASC', [question.question_id]).then(res => {
          return Promise.all(res.map(loadAnswer));
        })
      ]).then(spread((texts, answers) => {
        return Object.assign(
          ...Object.keys(texts).map(lang => ({
            [lang]: Object.assign({}, texts[lang], question, {
              answers: answers.map(answer => answer[lang])
            })
          }))
        );
      }));
    };
    
    loadAnswer = answer => {
      return ctx.query('SELECT language, atext FROM qn_answer_texts WHERE answer_id = ?', [answer.answer_id]).then(groupByLanguage)
      .then(texts => {
        return Object.assign(
          ...Object.keys(texts).map(lang => ({
            [lang]: Object.assign({}, texts[lang], answer)
          }))
        );
      });
    };
    
    return this.questionnaires = ctx.query('SELECT * FROM qn_questionnaires').then(res => {
      return Promise.all(res.map(loadQuestionnaire));
    }).then(questionnaires => {
      debug('Loaded questionnaires', questionnaires.length);
      
      return Object.assign(
        ...questionnaires.map(qn => ({ [qn.questionnaire_id]: qn }))
      );
    });
  }
}

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
      const ids = new Set(res.map(row => row.questionnaire_id));
      
      return {
        code: 200,
        data: {
          questionnaires: Object.assign(
            ...Object.keys(questionnaires).map(id => ids.has(id) ? {
              [id]: questionnaires[id]
            } : {})
          ),
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
    const questionnaireId = query.questionnaire;
    const fill_time = query.fill_time;
    
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
      
      const answeredQuestions = new Set(query.results.map(r => r.question));
      const availableQuestions = new Set(questionnaire.questions.map(q => q.question_id));
      
      if (answeredQuestions.size !== availableQuestions.size ||
        [...answeredQuestions].some(id => !availableQuestions.has(id))) {
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
        
        const chosenAnswers = answers.map(a => a.answer);
        const availableAnswers = new Set(question.answers.map(a => a.answer_id));
        const invalidAnswers = chosenAnswers.filter(id => !availableAnswers.has(id)); // jshint ignore:line
        
        if (invalidAnswers.length !== 0) {
          throw new this.ClientError('invalid-answers',
            'Invalid answer(s) for question ' + question.question_id + ': ' +
            JSON.stringify(invalidAnswers) +
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

exports.components = [
  QuestionnaireSave,
  QuestionnairesList
];
