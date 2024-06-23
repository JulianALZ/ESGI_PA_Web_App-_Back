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
import { DateTime } from 'luxon';


const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'PA_ESGI_DB_WOW'; // Remplacez par votre clé secrète

const API_KEY_ALPACA = "PKV15UO4V86ZU441S8OQ";
const SECRET_KEY_ALPACA = "ddZjf91gaow2srhSkSfOGykiT8Fx9EJezquQScmt";



const pool = new Pool({
	connectionString: 'postgresql://esgiPA_owner:a9dFHT0UEOhs@ep-dry-butterfly-a2jyjal0.eu-central-1.aws.neon.tech/esgiPA?sslmode=require',
	ssl: {
		rejectUnauthorized: false
	},
	port: 5432,
	connectionTimeoutMillis: 60000, // Timeout après 60 secondes si la connexion n'est pas établie
});

const endpointSecret = 'whsec_IsfxHwxOwleiSc3z2ev1ZgzlBsticFeX'; // Remplacez par votre secret de Webhook Stripe

app.use(cors());

const logError = (message, err) => {
	console.error(`${message}: ${err.stack}`);
};

const logInfo = (message) => {
	console.log(`${message}`);
};

const testDbConnection = async () => {
	logInfo('Testing database connection');
	try {
		const client = await pool.connect();
		const testQuery = await client.query('SELECT NOW()');
		logInfo('Test query result:', testQuery.rows[0]);
		client.release();
	} catch (err) {
		logError('Error testing DB connection', err);
	}
};

testDbConnection();

app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
	logInfo('Received webhook event');
	const sig = request.headers['stripe-signature'];

	let event;

	try {
		event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
		logInfo('Webhook event received:', event);
	} catch (err) {
		logError('⚠️  Webhook signature verification failed', err);
		return response.sendStatus(400);
	}

	if (event.type === 'checkout.session.completed') {
		const session = event.data.object;
		logInfo('Handling checkout.session.completed event');
		await handleCheckoutSessionCompleted(session);
	}

	response.json({ received: true });
});

const handleCheckoutSessionCompleted = async (session) => {
	logInfo('Entered handleCheckoutSessionCompleted');

	try {
		const client = await pool.connect();
		logInfo('Database connection established');

		const userId = 1; // Utiliser l'ID de l'utilisateur en brut pour le moment
		const amount = session.amount_total / 100; // Assurez-vous de convertir en unité monétaire correcte
		logInfo(`Processing session completed for user: ${userId} with amount: ${amount}`);

		// Récupérer la dernière valeur du wallet
		const result = await client.query(
			`SELECT wallet, date
			FROM user_action_history
			ORDER BY date DESC
			LIMIT 1`
		);
		const lastRecord = result.rows[0];
		const lastWallet = lastRecord.wallet;
		const lastDate = lastRecord.date;
		console.log("lastDate === ", lastDate);

		// Récupérer la valeur
		const resultGain = await getAccountPortfolioGain(lastDate);
		const gain = resultGain[0];
		const currentDate = resultGain[1];

		// Ajoutez la transaction à la base de données
		await insertUserActionHistoric(client, amount, lastWallet, gain, currentDate, userId);

		client.release();
		logInfo('Client connection released');
	} catch (err) {
		logError('Error in handleCheckoutSessionCompleted', err);
	}
};

async function getAccountPortfolioGain(startDate) {
	logInfo('Entered getAccountPortfolioGain');
	const url = "https://paper-api.alpaca.markets/v2/account/portfolio/history?pnl_reset=no_reset";

	const headers = {
		"accept": "application/json",
		"APCA-API-KEY-ID": API_KEY_ALPACA,
		"APCA-API-SECRET-KEY": SECRET_KEY_ALPACA
	};
	startDate = startDate.toISOString()
	startDate = DateTime.fromISO(startDate, { zone: 'utc' });

	const currentDate = DateTime.utc().toISO({ suppressMilliseconds: true });
	const startISO = startDate.toISO({ suppressMilliseconds: true });

	const params = new URLSearchParams({
		"timeframe": "1Min",
		"start": startISO,
		"end": currentDate,
		"intraday_reporting": "continuous"
	});

	const response = await fetch(`${url}&${params.toString()}`, { headers });
	const historicalData = await response.json();

	const startWallet = historicalData.equity[0];
	const currentWallet = historicalData.equity[historicalData.equity.length - 1];

	logInfo(`getAccountPortfolioGain result: ${[1 - (currentWallet - startWallet) / startWallet, currentDate]}`);
	return [1 - (currentWallet - startWallet) / startWallet, currentDate];
}

async function insertUserActionHistoric(client, deposit, lastWallet, gain, date, userId) {
	try {
		logInfo('Starting insertUserActionHistoric');
		// Ajoutez la transaction à la base de données
		await client.query(
			'INSERT INTO user_action_history (deposit, wallet, gain, date, user_id) VALUES ($1, $2, $3, $4, $5)',
			[deposit, lastWallet * gain + deposit, gain, date, userId]
		);
		logInfo(`Transaction recorded for user: ${userId}`);

		// Mettre à jour l'historique des montants de chaque utilisateur
		// Récupérer le dernier montant enregistré pour chaque utilisateur
		const res = await client.query(`
			SELECT user_id, wallet
			FROM UserWalletHistoric
			WHERE (user_id, date) IN (
				SELECT user_id, MAX(date)
				FROM UserWalletHistoric
				GROUP BY user_id
			);
		`);
		logInfo(`data recover for UserWalletHistoric table for user: ${userId}`);
		console.log("res.rows == ", res.rows);
		for (let row of res.rows) {
			const user_id_UserWalletHistoric = row.user_id;
			console.log("userId == " ,userId);
			let newMontant = row.wallet * gain;

			// Ajouter un montant supplémentaire pour l'utilisateur 1
			if (userId === user_id_UserWalletHistoric) {
				newMontant += deposit;
			}

			// Insérer le nouveau montant dans la table
			await client.query(`
				INSERT INTO UserWalletHistoric (user_id, wallet, date)
				VALUES ($1, $2, $3);
			`, [user_id_UserWalletHistoric, newMontant, date]);

			logInfo(`Transaction succeed for user: ${userId}`);
		}
	} catch (err) {
		logError('Error recording transaction', err);
	}
}

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
				wallet NUMERIC NOT NULL,
				gain NUMERIC NOT NULL,
				date TIMESTAMP NOT NULL,
				user_id INTEGER REFERENCES users(id)
			);
		`);
		await client.query(`
			CREATE TABLE IF NOT EXISTS UserWalletHistoric(
				id SERIAL PRIMARY KEY,
				wallet NUMERIC NOT NULL,
				date TIMESTAMP NOT NULL,
				user_id INTEGER REFERENCES users(id)
			);
		`);

		// Vérifiez si la table user_action_history est vide et insérez une ligne par défaut si elle est vide
		const result = await client.query('SELECT COUNT(*) FROM user_action_history');
		const count = parseInt(result.rows[0].count, 10);
		if (count === 0) {
			await client.query(`
				INSERT INTO user_action_history (deposit, wallet, gain, date, user_id)
				VALUES (0, 0, 0, '2024-06-23 13:59:29', NULL);
			`);
			logInfo('default row of user_action_history have been added');
		}

		logInfo('Tables created successfully');
	} catch (err) {
		logError('Error creating tables', err);
	} finally {
		client.release();
	}
};

// Créez les tables avant de démarrer le serveur
createTables().then(() => {
	app.listen(PORT, () => {
		logInfo(`Server running on http://localhost:${PORT}`);
	});
});


app.use(bodyParser.json()); // Utilisez bodyParser.json pour les autres routes

async function getAllPositionsRepartition() {
	const url = "https://paper-api.alpaca.markets/v2/positions";

	const headers = {
		"accept": "application/json",
		"APCA-API-KEY-ID": API_KEY_ALPACA,
		"APCA-API-SECRET-KEY": SECRET_KEY_ALPACA
	};

	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: headers
		});

		if (!response.ok) {
			console.log(`getAllPositionsRepartition = HTTP error! Status: ${response.status}`) ;
		}

		const positions = await response.json();

		const symbols = [];
		const amounts = [];

		positions.forEach(p => {
			symbols.push(p['symbol']);
			amounts.push(parseFloat(p['market_value']));
		});

		const total = amounts.reduce((acc, amount) => acc + amount, 0);
		const percentages = amounts.map(amount => (amount / total) * 100);

		return { symbols, percentages };
	} catch (error) {
		console.error('getAllPositionsRepartition = Error fetching positions:', error);
		throw error;
	}
}

// Route pour getAllPositionsRepartition
app.get('/api/positions', async (req, res) => {
	try {
		console.log("start api positions")
		const data = await getAllPositionsRepartition();
		res.json(data);
	} catch (error) {
		res.status(500).send('api positions = Error fetching positions');
	}
});

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
	} catch (err) {
		logError('Error executing query', err);
		res.status(500).send('Error executing query');
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
		const userResult = await client.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', [username, hashedPassword]);
		const userId = userResult.rows[0].id;
		const currentDate = new Date();

		// Insérez une ligne par défaut dans UserWalletHistoric pour le nouvel utilisateur
		await client.query('INSERT INTO UserWalletHistoric (wallet, date, user_id) VALUES ($1, $2, $3)', [0, currentDate, userId]);
		console.log(" api register = default row of UserWalletHistoric have been added")

		res.status(201).send('User created');
	} catch (err) {
		logError('Error executing query', err);
		res.status(500).send('Error executing query');
	} finally {
		client.release();
	}
});

app.get('/', (req, res) => {
	res.send('Server is running');
});
