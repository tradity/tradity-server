(function () { "use strict";

var _ = require('lodash');
var util = require('util');
var assert = require('assert');
var Q = require('q');
var buscomponent = require('./stbuscomponent.js');
var debug = require('debug')('sotrade:questionnaires');

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
function Questionnaires () {
	Questionnaires.super_.apply(this, arguments);
	
	this.questionnaires = null;
};

util.inherits(Questionnaires, buscomponent.BusComponent);

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
	var questionnaires = this.loadQuestionnaires(ctx);
	var uid = (ctx.user && ctx.user.uid) || null;
	
	return Q.all([
		questionnaires,
		ctx.query('SELECT questionnaire_id FROM qn_questionnaires ' +
			'WHERE (display_after IS NULL OR display_after <= UNIX_TIMESTAMP()) ' +
			(uid === null ? '' :
				'AND (SELECT COUNT(*) FROM qn_result_sets ' + 
				'WHERE uid = ? AND qn_result_sets.questionnaire_id = qn_questionnaires.questionnaire_id) = 0 '
			), uid === null ? [] : [uid])
		]).spread(function(questionnaires, res) {
		var ids = _.pluck(res, 'questionnaire_id');
		
		return { code: 'list-questionnaires-success', questionnaires: _.pick(questionnaires, ids) };
	});
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
	var self = this;
	
	if (parseInt(query.questionnaire) != query.questionnaire || parseInt(query.fill_time) != query.fill_time)
		throw new self.FormatError();
	
	query.fill_language = String(query.fill_language);
	
	if (!query.results || !query.results.length)
		throw new self.FormatError();
	
	var resultsQuery = [];
	var resultsArguments = [];
	
	return this.loadQuestionnaires(ctx).then(function(questionnaires) {
		if (!questionnaires.hasOwnProperty(query.questionnaire))
			throw new self.SoTradeClientError('save-questionnaire-unknown-questionnaire');
		
		var questionnaire = questionnaires[query.questionnaire][query.fill_language];
		
		if (!questionnaire)
			throw new self.SoTradeClientError('save-questionnaire-unknown-questionnaire');
		
		assert.ok(questionnaire.questionnaire_id);
		
		var answeredQuestions = _.pluck(query.results, 'question');
		var availableQuestions = _.pluck(questionnaire.questions, 'question_id');
		
		if (_.xor(answeredQuestions, availableQuestions).length > 0)
			throw new self.SoTradeClientError('save-questionnaire-incomplete');
		
		for (var i = 0; i < query.results.length; ++i) {
			var answers = query.results[i].answers;
			var question = questionnaire.questions.filter(function(qn) {
				return qn.question_id == query.results[i].question;
			})[0];
			
			assert.ok(question);
			
			if (!answers || (answers.length != 1 && !question.question_multiple_answers))
				throw new self.SoTradeClientError('save-questionnaire-invalid');
			
			var chosenAnswers = _.pluck(answers, 'answer');
			var availableAnswers = _.pluck(question.answers, 'answer_id');
			
			if (_.difference(chosenAnswers, availableAnswers).length > 0)
				throw new self.SoTradeClientError('save-questionnaire-invalid');
			
			for (var j = 0; j < answers.length; ++j) {
				resultsQuery.push('(%resultSetID%,?,?,?)');
				resultsArguments.push(question.question_id, answers[j].answer, answers[j].answer_freetext || null);
			}
		}
		
		return ctx.query('INSERT INTO qn_result_sets (questionnaire_id, uid, submission_time, fill_time, fill_language)' + 
			'VALUES (?, ?, UNIX_TIMESTAMP(), ?, ?)',
			[questionnaire.questionnaire_id, ctx.user.uid, query.fill_time, query.fill_language]);
	}).then(function(res) {
		var resultSetID = parseInt(res.insertId);
		
		return ctx.query('INSERT INTO qn_results (result_set_id, question_id, answer_id, answer_text) VALUES ' +
			resultsQuery.join(',').replace(/%resultSetID%/g, resultSetID), resultsArguments);
	}).then(function() {
		return { code: 'save-questionnaire-success' };
	});
});

/**
 * Perform the initial load of all questionnaires.
 * 
 * @return {object} A Q promise for a list of questionnaires.
 * @function module:questionnaires~Questionnaires#loadQuestionnaires
 */
Questionnaires.prototype.loadQuestionnaires = function(ctx) {
	debug('loadQuestionnaires', !!this.questionnaires);
	if (this.questionnaires)
		return this.questionnaires;
	
	var loadQuestionnaire, loadQuestion, loadAnswer, groupByLanguage;
	
	groupByLanguage = function(listWithLangAttribute) {
		var ret = _.groupBy(listWithLangAttribute, 'language');
		return _.mapValues(ret, function(list) { return _.omit(list[0], 'language'); });
	};
	
	loadQuestionnaire = function(questionnaire) {
		return Q.all([
			ctx.query('SELECT language, qtext FROM qn_quesionnaire_text WHERE questionnaire_id = ?', [questionnaire.questionnaire_id]).then(groupByLanguage),
			ctx.query('SELECT qn_questions.question_id, question_multiple_answers, `order` ' + 
				'FROM qn_questions_questionnaires AS qlist ' +
				'JOIN qn_questions ON qn_questions.question_id = qlist.question_id ' +
				'WHERE qlist.questionnaire_id = ? ORDER BY `order` ASC', [questionnaire.questionnaire_id])
				.then(function(res) {
				return Q.all(res.map(loadQuestion));
			})
		]).spread(function(texts, questions) {
			return _.mapValues(texts, function(entry, lang) {
				return _.extend(entry, questionnaire, {
					questions: _.pluck(questions, lang)
				});
			});
		}).then(function(questionnaireObject) {
			questionnaireObject.questionnaire_id = questionnaire.questionnaire_id;
			return questionnaireObject;
		});
	};
	
	loadQuestion = function(question) {
		return Q.all([
			ctx.query('SELECT language, qtext  FROM qn_questions_texts WHERE question_id = ?', [question.question_id]).then(groupByLanguage),
			ctx.query('SELECT qn_answers.answer_id, answer_freetext, `order` ' +
				'FROM qn_questions_answers AS alist ' +
				'JOIN qn_answers ON qn_answers.answer_id = alist.answer_id ' +
				'WHERE alist.question_id = ? ORDER BY `order` ASC', [question.question_id]).then(function(res) {
				return Q.all(res.map(loadAnswer));
			})
		]).spread(function(texts, answers) {
			return _.mapValues(texts, function(entry, lang) {
				return _.extend(entry, question, {
					answers: _.pluck(answers, lang)
				});
			});
		});
	};
	
	loadAnswer = function(answer) {
		return ctx.query('SELECT language, atext FROM qn_answer_texts WHERE answer_id = ?', [answer.answer_id]).then(groupByLanguage)
		.then(function(texts) {
			return _.mapValues(texts, function(entry) {
				return _.extend(entry, answer);
			});
		});
	};
	
	return this.questionnaires = ctx.query('SELECT * FROM qn_questionnaires').then(function(res) {
		return Q.all(res.map(loadQuestionnaire));
	}).then(function(questionnaires) {
		debug('Loaded questionnaires', questionnaires.length);
		
		return _.mapValues(_.groupBy(questionnaires, 'questionnaire_id'), 0);
	});
};

exports.Questionnaires = Questionnaires;

})();
