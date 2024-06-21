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
});

const endpointSecret = 'whsec_IsfxHwxOwleiSc3z2ev1ZgzlBsticFeX'; // Remplacez par votre secret de Webhook Stripe

app.use(cors());

// Test de la connexion à la base de données
const testDbConnection = () => {
	pool.connect((err, client, release) => {
		if (err) {
			return console.error('Error acquiring client', err.stack);
		}
		client.query('SELECT NOW()', (err, result) => {
			release();
			if (err) {
				return console.error('Error executing query', err.stack);
			}
			console.log('Test query result:', result.rows[0]);
		});
	});
};



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
			testDbConnection();
			handleCheckoutSessionCompleted(session);
			break;
		default:
			console.log(`Unhandled event type ${event.type}`);
	}

	response.json({ received: true });
});

const handleCheckoutSessionCompleted = (session) => {
	console.log('Entered handleCheckoutSessionCompleted'); // Log pour vérifier que la fonction est bien appelée

	console.log('Trying to connect to the database');
	pool.connect((err, client, release) => {
		if (err) {
			return console.error('Error acquiring client', err.stack);
		}
		console.log('Database connection established');

		const userId = 1; // Utiliser l'ID de l'utilisateur en brut pour le moment
		const amount = session.amount_total / 100; // Assurez-vous de convertir en unité monétaire correcte
		console.log('Processing session completed for user:', userId, 'with amount:', amount);

		client.query('INSERT INTO user_action_history (deposit, wallet, gain, user_id) VALUES ($1, $2, $3, $4) RETURNING *',
			[amount, 0, 0, userId], (err, result) => {
				release();
				if (err) {
					return console.error('Error executing query', err.stack);
				}
				console.log('Transaction recorded for user:', userId, 'Result:', result.rows[0]);
			}
		);
	});
};

const createTables = () => {
	pool.connect((err, client, release) => {
		if (err) {
			return console.error('Error acquiring client', err.stack);
		}
		client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            );
        `, (err) => {
			if (err) {
				return console.error('Error creating users table', err.stack);
			}
			client.query(`
                CREATE TABLE IF NOT EXISTS user_action_history (
                    id SERIAL PRIMARY KEY,
                    deposit NUMERIC NOT NULL,
                    wallet NUMERIC NOT NULL DEFAULT 0,
                    gain NUMERIC NOT NULL DEFAULT 0,
                    user_id INTEGER REFERENCES users(id)
                );
            `, (err) => {
				release();
				if (err) {
					return console.error('Error creating user_action_history table', err.stack);
				}
				console.log('Tables created successfully');
			});
		});
	});
};

// Créez les tables avant de démarrer le serveur
createTables();

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});

app.use(bodyParser.json()); // Utilisez bodyParser.json pour les autres routes

app.post('/api/login', (req, res) => {
	const { username, password } = req.body;
	pool.connect((err, client, release) => {
		if (err) {
			return console.error('Error acquiring client', err.stack);
		}
		client.query('SELECT * FROM users WHERE username = $1', [username], (err, result) => {
			release();
			if (err) {
				return res.status(500).send('Error executing query');
			}
			const user = result.rows[0];

			if (user && bcrypt.compareSync(password, user.password)) {
				const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '1h' });
				res.json({ token });
			} else {
				res.status(401).send('Invalid credentials');
			}
		});
	});
});

app.post('/api/register', (req, res) => {
	const { username, password } = req.body;
	pool.connect((err, client, release) => {
		if (err) {
			return console.error('Error acquiring client', err.stack);
		}
		client.query('SELECT * FROM users WHERE username = $1', [username], (err, result) => {
			if (err) {
				release();
				return res.status(500).send('Error executing query');
			}
			if (result.rows.length > 0) {
				release();
				return res.status(400).send('User already exists');
			}

			bcrypt.hash(password, 10, (err, hashedPassword) => {
				if (err) {
					release();
					return res.status(500).send('Error hashing password');
				}
				client.query('INSERT INTO users (username, password) VALUES ($1, $2)', [username, hashedPassword], (err) => {
					release();
					if (err) {
						return res.status(500).send('Error executing query');
					}
					res.status(201).send('User created');
				});
			});
		});
	});
});

app.get('/', (req, res) => {
	res.send('Server is running');
});
