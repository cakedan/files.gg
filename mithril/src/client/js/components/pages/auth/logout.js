const m = require('mithril');

const Page = require('../../page');
const Constants = require('../../../utils').Constants;

class CustomPage extends Page
{
	constructor(app)
	{
		super(app, {paths: ['/auth/logout']});
	}

	init(args, requestedPath)
	{
		console.log(args);
	}

	view()
	{
		return [
			m('div', {class: 'head text-center'}, [
				m('h1', 'hi')
			])
		];
	}
}

module.exports = CustomPage;