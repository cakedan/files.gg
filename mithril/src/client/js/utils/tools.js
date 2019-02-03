module.exports = {
	formatBytes: function(bytes, decimals) {
		decimals = decimals || 0;
		const divideBy = 1024;
		const amount = Math.floor(Math.log(bytes) / Math.log(divideBy));
		const type = (['B', 'KB', 'MB','GB', 'TB'])[amount];
		const fixed = parseFloat(bytes / Math.pow(divideBy, amount)).toFixed(decimals).split('.');
		return [parseInt(fixed.shift()).toLocaleString(), fixed.shift()].filter((v) => v).join('.') + ' ' + type;
	}
};