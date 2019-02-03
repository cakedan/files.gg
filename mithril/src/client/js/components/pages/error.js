const m = require('mithril');

const Page = require('../page');

class CustomPage extends Page
{
	constructor(app)
	{
		super(app, {
			paths: ['/error/:code'],
			class: 'error',
			meta: {
				title: '¯\_(ツ)_/¯'
			}
		});
	}

	init(args, requestedPath)
	{
		console.log(args);
	}

	view()
	{
		return [
			m('div', {class: 'head text-center'}, [
				m('h1', 'hey stop that')
			])
		];
	}
}

module.exports = CustomPage;