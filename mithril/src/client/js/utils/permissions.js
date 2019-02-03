module.exports = {
	OWNER: 1 << 1,
	SUPERADMIN: 1 << 2,
	ADMIN: 1 << 3,

	check: function(permission, perm) {
		perm = this[perm];
		return ((permission & perm) == perm);
	},
	checkSome: function(permission, perms) {
		return perms.some((perm) => this.check(permission, perm));
	}
};