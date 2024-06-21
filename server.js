import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import jwt from 'jsonwebtoken';
import bodyParser from 'body-parser';
import cors from 'cors';
import bcrypt from 'bcrypt';
import pkg from 'pg';
const { Pool } = pkg;
import stripePackage from 'stripe';
const stripe = stripePackage('sk_test_51PSnc4P6OFtHWfqTKEKGbqCyKlSrpQUzNtALbE1YxmYZSUb0DQllRPHM20qz4LSQtwzPTQ9x3ch4KrCDvc25ji4e00gIVM68wU'); // Remplacez par votre clé secrète Stripe

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'PA_ESGI_DB_WOW'; // Remplacez par votre clé secrète

const pool = new Pool({
	connectionString: 'postgresql://esgiPA_owner:a9dFHT0UEOhs@ep-dry-butterfly-a2jyjal0.eu-central-1.aws.neon.tech/esgiPA?sslmode=require',
	ssl: {
		rejectUnauthorized: false
	},
	port: 5432,
	connectionTimeoutMillis: 10000, // Timeout après 5 secondes si la connexion n'est pas établie
});

const endpointSecret = 'whsec_IsfxHwxOwleiSc3z2ev1ZgzlBsticFeX'; // Remplacez par votre secret de Webhook Stripe

app.use(cors());

const delay = ms => new Promise(res => setTimeout(res, ms));

const connectWithRetry = async (retries = 5, delayMs = 5000) => {
	while (retries > 0) {
		try {
			const client = await pool.connect();
			console.log('Database connection established');
			return client;
		} catch (err) {
			console.error('Error acquiring client, retries left:', retries - 1, err.stack);
			retries -= 1;
			if (retries === 0) throw err;
			await delay(delayMs);
		}
	}
};

// Test de la connexion à la base de données
const testDbConnection = async () => {
	try {
		const client = await connectWithRetry();
		const testQuery = await client.query('SELECT NOW()');
		console.log('Test query result:', testQuery.rows[0]);
		client.release();
	} catch (err) {
		console.error('Error testing DB connection:', err);
	}
};

testDbConnection();

app.post('/webhook', express.raw({ type: 'application/json' }), (request, response) => {
	const sig = request.headers['stripe-signature'];

	let event;

	try {
		event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
		console.log('Webhook event received:', event);
	} catch (err) {
		console.log(`⚠️  Webhook signature verification failed.`, err.message);
		return response.sendStatus(400);
	}

	switch (event.type) {
		case 'checkout.session.completed':
			const session = event.data.object;
			console.log('Session:', event.type);
			handleCheckoutSessionCompleted(session);
			break;
		default:
			console.log(`Unhandled event type ${event.type}`);
	}

	response.json({ received: true });
});

const handleCheckoutSessionCompleted = async (session) => {
	console.log('Entered handleCheckoutSessionCompleted'); // Log pour vérifier que la fonction est bien appelée

	try {
		console.log('Trying to connect to the database');
		const client = await connectWithRetry();
		console.log('Database connection established');

		const userId = 1; // Utiliser l'ID de l'utilisateur en brut pour le moment
		const amount = session.amount_total / 100; // Assurez-vous de convertir en unité monétaire correcte
		console.log('Processing session completed for user:', userId, 'with amount:', amount);

		const result = await client.query(
			'INSERT INTO user_action_history (deposit, wallet, gain, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
			[amount, 0, 0, userId]
		);
		console.log('Transaction recorded for user:', userId, 'Result:', result.rows[0]);

		client.release();
		console.log('Client connection released');
	} catch (err) {
		console.error('Error in handleCheckoutSessionCompleted:', err);
	}
};

const createTables = async () => {
	const client = await connectWithRetry();
	try {
		await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            );
        `);
		await client.query(`
            CREATE TABLE IF NOT EXISTS user_action_history (
                id SERIAL PRIMARY KEY,
                deposit NUMERIC NOT NULL,
                wallet NUMERIC NOT NULL DEFAULT 0,
                gain NUMERIC NOT NULL DEFAULT 0,
                user_id INTEGER REFERENCES users(id)
            );
        `);
		console.log('Tables created successfully');
	} catch (err) {
		console.error('Error creating tables:', err);
	} finally {
		client.release();
	}
};

// Créez les tables avant de démarrer le serveur
createTables().then(() => {
	app.listen(PORT, () => {
		console.log(`Server running on http://localhost:${PORT}`);
	});
});

app.use(bodyParser.json()); // Utilisez bodyParser.json pour les autres routes

app.post('/api/login', async (req, res) => {
	const { username, password } = req.body;
	const client = await connectWithRetry();

	try {
		const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
		const user = result.rows[0];

		if (user && bcrypt.compareSync(password, user.password)) {
			const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
			res.json({ token });
		} else {
			res.status(401).send('Invalid credentials');
		}
	} catch (err) {
		console.error('Error executing query:', err);
		res.status(500).send('Error executing query');
	} finally {
		client.release();
	}
});

app.post('/api/register', async (req, res) => {
	const { username, password } = req.body;
	const client = await connectWithRetry();

	try {
		const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
		if (result.rows.length > 0) {
			return res.status(400).send('User already exists');
		}

		const hashedPassword = await bcrypt.hash(password, 10);
		await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
		res.status(201).send('User created');
	} catch (err) {
		console.error('Error executing query:', err);
		res.status(500).send('Error executing query');
	} finally {
		client.release();
	}
});

app.get('/', (req, res) => {
	res.send('Server is running');
});
