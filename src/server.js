const app = require('./app');

const port = 5050;

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`API server listening on 0.0.0.0:${port}`);
});

server.on('error', (err) => {
  console.error(`Server listen error on port ${port}:`, err);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use.`);
  }
  process.exit(1);
});
