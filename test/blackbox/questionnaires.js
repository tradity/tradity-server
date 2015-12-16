'use strict';

var assert = require('assert');
var _ = require('lodash');
var testHelpers = require('./test-helpers.js');

describe('questionnaires', function() {
  var socket, user;
  var random;
  
  before(function() {
    var seed = Math.random();
    console.log('questionnaires seed', seed);
    
    random = function() {
      var x = Math.sin(seed++) * 100000;
      return x - Math.floor(x);
    };
    
    return testHelpers.standardSetup().then(function(data) {
      socket = data.socket;
      user = data.user;
    });
  });

  beforeEach(testHelpers.standardReset);
  after(testHelpers.standardTeardown);

  describe('list-questionnaires', function() {
    it('Should return a list of questionnaires', function() {
      return socket.emit('list-questionnaires').then(function(res) {
        assert.equal(res.code, 'list-questionnaires-success');
      });
    });
  });
  
  describe('save-questionnaire-feed', function() {
    it('Should save a questionnaire’s results', function() {
      return socket.emit('list-questionnaires').then(function(data) {
        assert.equal(data.code, 'list-questionnaires-success');
        
        var startTime = Date.now();
        
        var questionnaireIDs = Object.keys(data.questionnaires);
        if (questionnaireIDs.length == 0)
          return;
        
        var questionnaireLangs = data.questionnaires[questionnaireIDs[parseInt(random() * questionnaireIDs.length)]];
        var languages = Object.keys(questionnaireLangs).filter(function(s) { return s != 'questionnaire_id'; });
        assert.ok(languages.length > 0);
        
        var lang = languages[parseInt(random() * languages.length)];
        
        var questionnaire = questionnaireLangs[lang];
        assert.ok(questionnaire);
        assert.equal(questionnaire.questionnaire_id, questionnaireLangs.questionnaire_id);
        assert.ok(questionnaire.qtext);
        assert.ok(questionnaire.questions);
        assert.ok(questionnaire.questions.length > 0);
        
        var results = questionnaire.questions.map(function(qn) {
          assert.ok(qn.qtext);
          assert.equal(typeof qn.question_id, 'number');
          assert.equal(typeof qn.order, 'number');
          
          qn.answers.forEach(function(answer) {
            assert.ok(answer.atext);
            assert.equal(typeof answer.answer_id, 'number');
            assert.equal(typeof answer.order, 'number');
          });
          
          var answerSet;
          
          if (qn.question_multiple_answers) {
            answerSet = qn.answers.filter(function(answer) {
              return random() < 0.5;
            });
          } else {
            answerSet = [qn.answers[parseInt(random() * qn.answers.length)]];
          }
          
          return {
            question: qn.question_id,
            answers: answerSet.map(function(answer) {
              var ret = { answer: answer.answer_id };
              if (answer.answer_freetext)
                ret.text = 'Banana';
              return ret;
            })
          };
        });
        
        return socket.emit('save-questionnaire', {
          results: results,
          questionnaire: questionnaire.questionnaire_id,
          fill_time: Date.now() - startTime,
          fill_language: lang
        }).then(function(data) {
          assert.equal(data.code, 'save-questionnaire-success');
          
          return socket.emit('list-questionnaires');
        }).then(function(data) {
          assert.equal(data.code, 'list-questionnaires-success');
          
          assert.equal(Object.keys(data.questionnaires).map(parseInt).indexOf(questionnaire.questionnaire_id), -1);
        });
      });
    });
  });
});
