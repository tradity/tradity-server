UPDATE qn_questions_texts SET qtext = "<p>Lukas hat sein ganzes Geld in eine Aktie investiert. Lena hat ihr Geld auf zehn verschiedene Aktien aufgeteilt.</p><p class='instruction'>Wer von den beiden hat deiner Meinung nach ein höheres Risiko sein Geld zu verlieren?</p>" WHERE question_id = 4 AND language='de';
INSERT INTO qn_answers (answer_id, answer_freetext) VALUES (91, 0);
INSERT INTO qn_answer_texts (answer_id, language, atext) VALUES
(91, "de", "Die Aktie war unter den Top-Wertpapieren auf Tradity.de."),
(91, "en", "The stock was one of the most popular stocks on Tradity.de.");
INSERT INTO qn_questions_answers(question_id, answer_id, `order`) VALUES (16, 91, -10);
RENAME TABLE qn_quesionnaire_text TO qn_questionnaire_text;

ALTER TABLE qn_questionnaires ADD display_before bigint NULL;
UPDATE qn_questionnaires SET display_before = 1448733771 WHERE questionnaire_id = 1;
UPDATE qn_questionnaires SET display_before = NULL WHERE questionnaire_id = 2;


UPDATE qn_answer_texts SET language="en" WHERE answer_id = 86 and atext = "… confused me.";
UPDATE qn_answer_texts SET language="en" WHERE answer_id = 87 and atext = "… annoyed me.";
UPDATE qn_answer_texts SET language="en" WHERE answer_id = 88 and atext = "… didn’t matter.";
UPDATE qn_answer_texts SET language="en" WHERE answer_id = 89 and atext = "… I haven’t realized.";
UPDATE qn_answer_texts SET language="en" WHERE answer_id = 90 and atext = "… was a good thing.";

ALTER TABLE qn_answer_texts ADD UNIQUE KEY `answer_id` (`answer_id`, `language`);
ALTER TABLE qn_questions_texts ADD UNIQUE KEY `question_id` (`question_id`, `language`);
