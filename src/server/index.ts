import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0', name: 'Open Source OD' });
});

app.listen(PORT, () => {
  console.log(`OSOD server running on http://localhost:${PORT}`);
});
