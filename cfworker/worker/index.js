require('./bootstrap');

const EventHandler = require('./eventhandler');

const eventHandler = new EventHandler({bucket: GCS_BUCKET});

addEventListener('fetch', eventHandler.onfetch.bind(eventHandler));