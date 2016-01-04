START TRANSACTION;
DELETE FROM achievements;
DELETE FROM depot_stocks;
DELETE FROM dqueries;
DELETE FROM transactionlog;
DELETE FROM orderhistory;
SET foreign_key_checks = 0;
DELETE FROM events WHERE `type` IN("dquery-exec", "trade", "achievement");
DELETE FROM ecomments WHERE (SELECT COUNT(*) FROM events WHERE events.eventid=ecomments.eventid) = 0;
DELETE FROM events WHERE type ="comment" AND (SELECT COUNT(*) FROM ecomments WHERE events.targetid=ecomments.commentid) = 0;
DELETE FROM events_users WHERE (SELECT COUNT(*) FROM events WHERE events.eventid=events_users.eventid) = 0;
SET foreign_key_checks = 1;
UPDATE users_finance SET freemoney = 1000000000, totalvalue = 1000000000,
fperf_bought = 0, fperf_sold = 0, fperf_cur = 0,
operf_bought = 0, operf_sold = 0, operf_cur = 0,
wprov_sum = 0, lprov_sum = 0;
UPDATE users SET tradecount = 0;
UPDATE watchlists SET watchstartvalue = 10000000;
UPDATE stocks SET daystartvalue = 10000000, weekstartvalue = 10000000 WHERE leader IS NOT NULL;
COMMIT;
TRUNCATE TABLE valuehistory;
