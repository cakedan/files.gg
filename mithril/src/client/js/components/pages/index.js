const pages = [];

const forEachPage = (page) => {
	if (Array.isArray(page)) {
		page.forEach(forEachPage);
	} else {
		pages.push(page);
	}
};

forEachPage([
	require('./home'),
	require('./tos'),
	require('./auth'),
	require('./error'),
	require('./file')
]);

module.exports = pages;