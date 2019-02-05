const fs = require('fs');

const webpack = require('webpack');
const RestClient = require('detritus-rest').Client;

const config = require('../config.json');

const cmd = process.argv[2];

const actions = {
	deploy() {
		return actions.build().then(actions.upload).then(() => {
			console.log('-'.repeat(10), 'woo done');
		});
	},
	build() {
		console.log('-'.repeat(10), 'Building Bundle...');

		return new Promise((resolve, reject) => {
			webpack({
				entry: process.env.ENTRYPOINT || './worker/index.js',
				devtool: 'nosources-source-map',
				mode: 'development',
				output: {filename: 'bundle.js'},
			}, (e, stats) => {
				if (e || stats.hasErrors()) {
					console.error(e);
					return reject(stats);
				}
				resolve(stats);
			});
		});
	},
	upload() {
		console.log('-'.repeat(10), 'Reading Bundle...');
		return new Promise((resolve, reject) => {
			fs.readFile('./dist/bundle.js', (e, body) => {
				if (e) {return reject(e);}
				resolve(body);
			});
		}).then((body) => {
			console.log('-'.repeat(10), 'Uploading Bundle...');
			const client = new RestClient({baseUrl: 'https://api.cloudflare.com'});
			return client.request({
				route: {
					method: 'put',
					path: 'client/v4/zones/:zoneId:/workers/script',
					params: {zoneId: config.CF_ZONE_ID}
				},
				headers: {
					'content-type': 'application/javascript',
					'X-Auth-Email': config.CF_AUTH_EMAIL,
					'X-Auth-Key': config.CF_API_KEY
				},
				jsonify: false,
				body
			}).then((response) => {
				console.log(response);
				return response.body().then((body) => {
          console.log(body);
        });
			});
		});
	}
};

const action = actions[cmd.toLowerCase()];
if (!action) {throw new Error('lol that doesnt exist bud');}
action().catch(console.error);