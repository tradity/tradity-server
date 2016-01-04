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

'use strict';

const assert = require('assert');
const testHelpers = require('./test-helpers.js');

describe('questionnaires', function() {
  let socket, user, random;
  
  before(function() {
    let seed = Math.random();
    
    random = function() {
      const x = Math.sin(seed++) * 100000;
      return x - Math.floor(x);
    };
    
    return testHelpers.standardSetup().then(data => {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('list-questionnaires', function() {
    it('Should return a list of questionnaires', function() {
      return socket.emit('list-questionnaires').then(res => {
        assert.equal(res.code, 'list-questionnaires-success');
      });
    });
  });
  
  describe('save-questionnaire-feed', function() {
    it('Should save a questionnaire’s results', function() {
      return socket.emit('list-questionnaires').then(data => {
        assert.equal(data.code, 'list-questionnaires-success');
        
        const startTime = Date.now();
        
        const questionnaireIDs = Object.keys(data.questionnaires);
        if (questionnaireIDs.length === 0) {
          return;
        }
        
        const questionnaireLangs = data.questionnaires[questionnaireIDs[parseInt(random() * questionnaireIDs.length)]];
        const languages = Object.keys(questionnaireLangs).filter(s => s !== 'questionnaire_id');
        assert.ok(languages.length > 0);
        
        const lang = languages[parseInt(random() * languages.length)];
        
        const questionnaire = questionnaireLangs[lang];
        assert.ok(questionnaire);
        assert.equal(questionnaire.questionnaire_id, questionnaireLangs.questionnaire_id);
        assert.ok(questionnaire.qtext);
        assert.ok(questionnaire.questions);
        assert.ok(questionnaire.questions.length > 0);
        
        const results = questionnaire.questions.map(function(qn) {
          assert.ok(qn.qtext);
          assert.equal(typeof qn.question_id, 'number');
          assert.equal(typeof qn.order, 'number');
          
          qn.answers.forEach(function(answer) {
            assert.ok(answer.atext);
            assert.equal(typeof answer.answer_id, 'number');
            assert.equal(typeof answer.order, 'number');
          });
          
          let answerSet;
          
          if (qn.question_multiple_answers) {
            answerSet = qn.answers.filter(() => random() < 0.5);
          } else {
            answerSet = [qn.answers[parseInt(random() * qn.answers.length)]];
          }
          
          return {
            question: qn.question_id,
            answers: answerSet.map(answer => {
              const ret = { answer: answer.answer_id };
              if (answer.answer_freetext) {
                ret.text = 'Banana';
              }
              return ret;
            })
          };
        });
        
        return socket.emit('save-questionnaire', {
          results: results,
          questionnaire: questionnaire.questionnaire_id,
          fill_time: Date.now() - startTime,
          fill_language: lang
        }).then(data => {
          assert.equal(data.code, 'save-questionnaire-success');
          
          return socket.emit('list-questionnaires');
        }).then(data => {
          assert.equal(data.code, 'list-questionnaires-success');
          
          assert.equal(Object.keys(data.questionnaires).map(parseInt).indexOf(questionnaire.questionnaire_id), -1);
        });
      });
    });
  });
});
