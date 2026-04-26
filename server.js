// server.js
// Express server with health check, weather and forecast endpoints, SQLite caching, and static file serving.

// Imports (all at top as required)
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8000;

// Initialize SQLite database (file: weather.db in project root)
const db = new sqlite3.Database(path.resolve(__dirname, 'weather.db'), (err) => {
  if (err) {
    console.error('Failed to connect to SQLite database:', err.message);
    process.exit(1);
  }
});

// Create tables for caching if they don't exist
const createTables = () => {
  const weatherTable = `
    CREATE TABLE IF NOT EXISTS weather_cache (
      city TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`;
  const forecastTable = `
    CREATE TABLE IF NOT EXISTS forecast_cache (
      city TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );`;

  db.run(weatherTable, (err) => {
    if (err) console.error('Error creating weather_cache table:', err.message);
  });
  db.run(forecastTable, (err) => {
    if (err) console.error('Error creating forecast_cache table:', err.message);
  });
};

createTables();

// Helper: get cached weather data for a city
function getCachedWeather(city) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT data FROM weather_cache WHERE city = ?`;
    db.get(sql, [city], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      try {
        const parsed = JSON.parse(row.data);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Helper: cache weather data
function cacheWeather(city, data) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(data);
    const sql = `INSERT OR REPLACE INTO weather_cache (city, data) VALUES (?, ?)`;
    db.run(sql, [city, json], function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Helper: get cached forecast data for a city
function getCachedForecast(city) {
  return new Promise((resolve, reject) => {
    const sql = `SELECT data FROM forecast_cache WHERE city = ?`;
    db.get(sql, [city], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      try {
        const parsed = JSON.parse(row.data);
        resolve(parsed);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Helper: cache forecast data
function cacheForecast(city, data) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(data);
    const sql = `INSERT OR REPLACE INTO forecast_cache (city, data) VALUES (?, ?)`;
    db.run(sql, [city, json], function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Middleware to serve static files from the "static" directory
app.use(express.static(path.join(__dirname, 'static')));

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('Health endpoint error:', e);
    res.status(500).json({ error: e.message });
  }
});

// /api/weather endpoint – returns current weather for a city
app.get('/api/weather', async (req, res) => {
  try {
    const city = req.query.city;
    if (!city) {
      return res.status(400).json({ error: 'Query parameter "city" is required' });
    }

    // Try to serve cached data first
    const cached = await getCachedWeather(city.toLowerCase());
    if (cached) {
      return res.json(cached);
    }

    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENWEATHER_API_KEY not configured');
    }

    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;
    const apiResponse = await fetch(url);

    // Handle invalid city – return 404 with meaningful message
    if (!apiResponse.ok) {
      if (apiResponse.status === 404) {
        return res.status(404).json({ error: `City '${city}' not found` });
      }
      const errorText = await apiResponse.text();
      throw new Error(`Weather service error ${apiResponse.status}: ${errorText}`);
    }

    const weatherData = await apiResponse.json();
    // Cache the fresh data (store city in lowercase for case‑insensitive lookup)
    await cacheWeather(city.toLowerCase(), weatherData);
    res.json(weatherData);
  } catch (e) {
    console.error('Error in /api/weather:', e);
    res.status(500).json({ error: e.message });
  }
});

// /api/forecast endpoint – returns 7‑day forecast for a city
app.get('/api/forecast', async (req, res) => {
  try {
    const city = req.query.city;
    if (!city) {
      return res.status(400).json({ error: 'Query parameter "city" is required' });
    }

    // Check cache first
    const cached = await getCachedForecast(city.toLowerCase());
    if (cached) {
      return res.json(cached);
    }

    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
      throw new Error('OPENWEATHER_API_KEY not configured');
    }

    // First, get coordinates for the city via the current weather endpoint (lightweight)
    const geoUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}`;
    const geoResp = await fetch(geoUrl);
    if (!geoResp.ok) {
      if (geoResp.status === 404) {
        return res.status(404).json({ error: `City '${city}' not found` });
      }
      const errText = await geoResp.text();
      throw new Error(`Geo lookup error ${geoResp.status}: ${errText}`);
    }
    const geoData = await geoResp.json();
    const { lon, lat } = geoData.coord;

    // Now fetch the 7‑day forecast using One Call API (excluding minutely/hourly for brevity)
    const forecastUrl = `https://api.openweathermap.org/data/2.5/onecall?lat=${lat}&lon=${lon}&exclude=current,minutely,hourly,alerts&units=metric&appid=${apiKey}`;
    const forecastResp = await fetch(forecastUrl);
    if (!forecastResp.ok) {
      const errText = await forecastResp.text();
      throw new Error(`Forecast service error ${forecastResp.status}: ${errText}`);
    }
    const forecastData = await forecastResp.json();
    // Cache forecast data
    await cacheForecast(city.toLowerCase(), forecastData);
    res.json(forecastData);
  } catch (e) {
    console.error('Error in /api/forecast:', e);
    res.status(500).json({ error: e.message });
  }
});

// Fallback route for SPA – serve index.html for any unknown path
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
