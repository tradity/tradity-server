#!/usr/bin/env node
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

const SignedMessaging = require('./signedmsg.js').SignedMessaging;
const cfg = require('./config.js').config();

const smdb = new SignedMessaging();
smdb.useConfig(cfg);

if (process.argv.length < 2) {
  console.log('signing requires a JSON-encoded object as a parameter');
  process.exit(0);
}

smdb.createSignedMessage(JSON.parse(process.argv[2])).then(msg => {
  console.log(msg);
}).catch(e => console.trace(e));
