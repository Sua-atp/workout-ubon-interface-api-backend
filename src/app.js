const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const routes = require('./routes');

dotenv.config({ override: true });

const app = express();
const BODY_LIMIT = process.env.JSON_BODY_LIMIT || '20mb';

app.use(cors());
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));
app.use('/tools', express.static(path.join(__dirname, '../public')));
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use(routes);

module.exports = app;