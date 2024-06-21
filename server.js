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
	port: 5432,
});

const endpointSecret = 'whsec_IsfxHwxOwleiSc3z2ev1ZgzlBsticFeX'; // Remplacez par votre secret de Webhook Stripe

app.use(cors());

// Route pour les webhooks Stripe, avec le middleware express.raw pour traiter le payload brut
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
			console.log('Session:', session);
			handleCheckoutSessionCompleted(session);
			break;
		default:
			console.log(`Unhandled event type ${event.type}`);
	}

	response.json({ received: true });
});

const handleCheckoutSessionCompleted = async (session) => {
	console.log('Entered handleCheckoutSessionCompleted'); // Log pour vérifier que la fonction est bien appelée
	const client = await pool.connect();
	try {
		const userId = 1; // Utiliser l'ID de l'utilisateur en brut pour le moment
		const amount = session.amount_total / 100; // Assurez-vous de convertir en unité monétaire correcte
		console.log('Processing session completed for user:', userId, 'with amount:', amount);

		// Ajoutez la transaction à la base de données
		const result = await client.query(
			'INSERT INTO user_action_history (deposit, wallet, gain, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
			[amount, 0, 0, userId]
		);
		console.log('Transaction recorded for user:', userId, 'Result:', result.rows[0]);
	} catch (err) {
		console.error('Error recording transaction:', err);
	} finally {
		client.release();
		console.log('Client connection released');
	}
};

const createTables = async () => {
	const client = await pool.connect();
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
		console.log('end handleCheckoutSessionCompleted');
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
	const client = await pool.connect();

	try {
		const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
		const user = result.rows[0];

		if (user && bcrypt.compareSync(password, user.password)) {
			const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
			res.json({ token });
		} else {
			res.status(401).send('Invalid credentials');
		}
	} finally {
		client.release();
	}
});

app.post('/api/register', async (req, res) => {
	const { username, password } = req.body;
	const client = await pool.connect();

	try {
		const result = await client.query('SELECT * FROM users WHERE username = $1', [username]);
		if (result.rows.length > 0) {
			return res.status(400).send('User already exists');
		}

		const hashedPassword = await bcrypt.hash(password, 10);
		await client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword]);
		res.status(201).send('User created');
	} finally {
		client.release();
	}
});

app.get('/', (req, res) => {
	res.send('Server is running');
});
