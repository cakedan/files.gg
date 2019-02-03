const App = require('./application');

(() => {
	const app = new App('', {recaptchaKey: '6Ld9nFcUAAAAAACsN328JLBsqikCn2wbTQDTVj4J'});
	app.start();
})();