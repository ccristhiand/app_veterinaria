'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const { combine, timestamp, printf, colorize, errors } = format;

const logFormat = printf(({ level, message, timestamp, stack }) => {
  return `${timestamp} [${level}]: ${stack || message}`;
});

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true }),
    logFormat,
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new transports.File({
      filename: path.join(__dirname, '../../logs/error.log'),
      level: 'error',
      maxsize: 5_242_880, // 5 MB
      maxFiles: 5,
    }),
    new transports.File({
      filename: path.join(__dirname, '../../logs/combined.log'),
      maxsize: 5_242_880,
      maxFiles: 5,
    }),
  ],
  exceptionHandlers: [
    new transports.File({ filename: path.join(__dirname, '../../logs/exceptions.log') }),
  ],
});

module.exports = logger;
