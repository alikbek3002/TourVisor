import { Router } from 'express';
import { config } from '../config.js';

export const healthRouter: Router = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'aisuluu-tourbot',
    features: config.features,
    time: new Date().toISOString(),
  });
});

healthRouter.get('/', (_req, res) => {
  res.type('text/plain').send('Aisuluu Tourbot is running. See /health');
});
