const m = require('mithril');

const Page = require('../../page');
const Constants = require('../../../utils').Constants;

class CustomPage extends Page
{
	constructor(app)
	{
		super(app, {
			paths: ['/auth/login'],
			class: 'auth-login'
		});

		this.recaptcha = this.app.recaptcha;

		this.register = false;

		this.email = {value: null, valid: false, error: null, show: false};
		this.username = {value: null, valid: false, error: null, show: false};
		this.password = {value: null, valid: false, error: null, show: false};
		this.captcha = {valid: false, show: false};
	}

	setType() {this.register = !this.register;}

	setEmail(email)
	{
		this.email.value = email;
		//validate it
	}

	setUsername(username)
	{
		this.username.value = username;
		//validate it
	}

	setPassword(password)
	{
		this.password.value = password;
		//validate it
	}

	submit()
	{
		console.log((this.register) ? 'register' : 'login', this.email, this.username, this.password);
		const response = this.recaptcha.getResponse();
		console.log('response', response);

		this.captcha.show = true;
		this.email.show = true;
		this.username.show = true;
		this.password.show = true;

		this.captcha.valid = !!response;

		const check = ['username', 'password'];
		if (this.register) {check.push('email');}

		for (let type of check) {
			if (this[type].valid) {continue;}
			return;
		}
		if (!this.captcha.valid) {return;}

		if (this.register) {
			//register
		} else {
			//login
		}
	}

	init(args, requestedPath)
	{
		console.log(args);
	}

	view()
	{
		const fields = ['username', 'password'];
		if (this.register) {
			fields.unshift('email');
		}

		return [
			m('div', {class: 'form-data'}, [
				m('div', {class: 'head'}, [
					m('h1', (this.register) ? 'Register' : 'Login'),
					m('span', {onclick: this.setType.bind(this)}, `click here to ${(this.register) ? 'login' : 'register'}`)
				]),
				m('div', {class: 'data'}, [
					m('div', {class: 'fields'}, fields.map((key) => {
						const field = [];

						const labelAttributes = {};
						if (this[key].show) {
							if (this[key].valid) {
								labelAttributes.class = 'valid';
							} else {
								labelAttributes.class = 'invalid';
							}
						}

						field.push(m('div', {class: 'label'}, [m('span', labelAttributes, key), ':']));

						field.push([
							m('input', {
								type: key,
								oninput: m.withAttr('value', this[`set${key.slice(0, 1).toUpperCase() + key.substr(1)}`].bind(this)),
								value: this[key].value
							})
						]);
						
						return m('div', {class: 'field'}, field);
					}))
				]),
				m('div', {
					class: [
						'captcha',
						(this.captcha.show && !this.captcha.valid) ? 'invalid' : null
					].filter((v) => v).join(' ')
				}, [
					m(this.recaptcha, {'data-size': 'compact'})
				]),
				m('div', {class: 'submit'}, [
					m('span', {onclick: this.submit.bind(this)}, (this.register) ? 'Register' : 'Login')
				])
			]),
			m('div', {class: 'oauth'}, [
				m('div', {class: 'head'}, [
					m('h5', 'Login using one of these sites')
				]),
				m('div', {class: 'sites'}, [
					m('span', {class: 'site discord'}),
					m('span', {class: 'site google'})
				])
			])
		];
	}
}

module.exports = CustomPage;