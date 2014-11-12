"use strict";

/* globals module, require */

var db = module.parent.require('./database'),
	winston = module.parent.require('winston'),
	elasticsearch = require('elasticsearch'),
	async = module.parent.require('async'),
	_ = module.parent.require('underscore'),

	LRU = require('lru-cache'),
	cache = LRU({ max: 20, maxAge: 1000 * 60 * 60 }),	// Remember the last 20 searches in the past hour

	topics = module.parent.require('./topics'),
	posts = module.parent.require('./posts'),

	// This method is necessary until solr-client 0.3.x is released
	escapeSpecialChars = function(s) {
		return s.replace(/([\+\-&\|!\(\)\{\}\[\]\^"~\*\?:\\\ ])/g, function(match) {
			return '\\' + match;
		});
	},

	Elasticsearch = {
		/*
			Defaults configs:
			host: localhost:9200
			enabled: undefined (false)
		*/
		config: {
			sniffOnStart: true,             // Should the client attempt to detect the rest of the cluster when it is first instantiated?
			sniffInterval: 60000,           // Every n milliseconds, perform a sniff operation and make sure our list of nodes is complete.
			sniffOnConnectionFault: true,   // Should the client immediately sniff for a more current list of nodes when a connection dies?
			host: 'localhost:9200'
		},	// default is localhost:9200
		client: undefined
	};

Elasticsearch.init = function(data, callback) {
	var pluginMiddleware = require('./middleware'),
		render = function(req, res, next) {
			// Regenerate csrf token
			var token = req.csrfToken();

			res.render('admin/plugins/elasticsearch', {
				ping: res.locals.ping,
				enabled: res.locals.enabled,
				stats: res.locals.stats,
				csrf: token
			});
		};

	data.router.get('/admin/plugins/elasticsearch', data.middleware.applyCSRF, data.middleware.admin.buildHeader, pluginMiddleware.ping, pluginMiddleware.getEnabled, pluginMiddleware.getStats, render);
	data.router.get('/api/admin/plugins/elasticsearch', data.middleware.applyCSRF, pluginMiddleware.ping, pluginMiddleware.getEnabled, pluginMiddleware.getStats, render);

	// Utility
	data.router.post('/admin/plugins/elasticsearch/rebuild', data.middleware.admin.isAdmin, Elasticsearch.rebuildIndex);
	data.router.post('/admin/plugins/elasticsearch/toggle', Elasticsearch.toggle);
	data.router.delete('/admin/plugins/elasticsearch/flush', data.middleware.admin.isAdmin, Elasticsearch.flush);

	Elasticsearch.getSettings(Elasticsearch.connect);

	callback();
};

Elasticsearch.ping = function(callback) {
	if (Elasticsearch.client) {
		Elasticsearch.client.ping(callback);
	} else {
		callback(new Error('not-connected'));
	}
};

Elasticsearch.checkConflict = function() {
	if (module.parent.exports.libraries['nodebb-plugin-dbsearch']) {
		return true;
	} else {
		return false;
	}
};

Elasticsearch.getNotices = function(notices, callback) {
	Elasticsearch.ping(function(err, obj) {
		var elasticsearchNotices = [
				{ done: !err ? true : false, doneText: 'Elasticsearch connection OK', notDoneText: 'Could not connect to Elasticsearch server' },
				{ done: parseInt(Elasticsearch.config.enabled, 10) || false, doneText: 'Elasticsearch Indexing Enabled', notDoneText: 'Elasticsearch Indexing Disabled' }
			];

		callback(null, notices.concat(elasticsearchNotices));
	})
};

Elasticsearch.getSettings = function(callback) {
	db.getObject('settings:elasticsearch', function(err, config) {
		Elasticsearch.config = {};
		if (!err) {
			for(var k in config) {
				if (config.hasOwnProperty(k) && config[k].length && !Elasticsearch.config.hasOwnProperty(k)) {
					Elasticsearch.config[k] = config[k];
				}
			}
		} else {
			winston.error('[plugin:elasticsearch] Could not fetch settings, assuming defaults.');
		}

		callback();
	});
};

Elasticsearch.getRecordCount = function(callback) {
	if (!Elasticsearch.client) {
		return callback(new Error('not-connected'));
	}

	Elasticsearch.client.count({
		index: Elasticsearch.config.posts_index_name
	}, function (error, response) {
		if (!error && response) {
			callback(null, response.count);
		}
		else {
			callback(error, 0);
		}
	});
};

Elasticsearch.getTopicCount = function(callback) {
	if (!Elasticsearch.client) {
		return callback(new Error('not-connected'));
	}

	// TODO
	Elasticsearch.client.count({
		index: Elasticsearch.config.posts_index_name/*,
		type: 'posts',
		body: {
			exists: {
				field: "title"
			}
		}*/
	}, function (error, response) {
		if (!error && response) {
			callback(null, response.count);
		}
		else {
			callback(error, 0);
		}
	});
};

Elasticsearch.connect = function() {
	if (!Elasticsearch.config.host) {
		return;
	}

	if (Elasticsearch.client) {
		delete Elasticsearch.client;
	}

	Elasticsearch.client = new elasticsearch.Client(Elasticsearch.config);

	//TODO Basic Auth
	/*
	if (Elasticsearch.config.username && Elasticsearch.config.password) {
		Elasticsearch.client.basicAuth(Elasticsearch.config.username, Elasticsearch.config.password);
	}
	*/
};

Elasticsearch.adminMenu = function(custom_header, callback) {
	custom_header.plugins.push({
		"route": '/plugins/elasticsearch',
		"icon": 'fa-search',
		"name": 'Elasticsearch'
	});

	callback(null, custom_header);
};

Elasticsearch.search = function(data, callback) {
	if (Elasticsearch.checkConflict()) {
		// The dbsearch plugin was detected, abort search!
		winston.warn('[plugin/elasticsearch] Another search plugin (dbsearch) is enabled, so search via Elasticsearch was aborted.');
		return callback(null, data);
	} else if (data.index === 'topic') {
		// We are only using the "post" index, because Elasticsearch does its own relevency sorting
		return callback(null, []);
	}

	if (cache.has(data.query)) {
		callback(null, cache.get(data.query));
	} else {

		if (!Elasticsearch.client) {
			return callback(new Error('not-connected'));
		}

		var query = {
			body: {
				query: {
					dis_max: {
						queries: [
							{
								match: {
									content: escapeSpecialChars(data.query)
								}
							},
							{
								match: {
									title: escapeSpecialChars(data.query)
								}
							}
						]
					}
				},
				from: 0,
				size: 20
			}
		};

		Elasticsearch.client.search(query, function(err, obj) {
			if (err) {
				callback(err);
			} else if (obj && obj.hits && obj.hits.hits && obj.hits.hits.length > 0) {
				var payload = obj.hits.hits.map(function(result) {
					return result._id;
				});

				callback(null, payload);
				cache.set(data.query, payload);
			} else {
				callback(null, []);
				cache.set(data.query, []);
			}
		});
	}
};

Elasticsearch.searchTopic = function(data, callback) {
	var tid = data.tid,
		term = data.term;

	async.parallel({
		mainPid: async.apply(topics.getTopicField, tid, 'mainPid'),
		pids: async.apply(topics.getPids, tid)
	}, function(err, data) {

		if (!Elasticsearch.client) {
			return callback(new Error('not-connected'));
		}

		if (data.mainPid && data.pids.indexOf(data.mainPid) === -1) {
			data.pids.unshift(data.mainPid);
		}

		// Make sure ids are integers
		data.pids = _.map(data.pids, function(p) {
			if (_.isString(p)) {
				return parseInt(p, 10);
			}
			return p;
		});

		var query = {
			body: {
				query: {
					filtered: {
						query: {
							match: {
								content: escapeSpecialChars(term)
							}
						},
						filter: {
							ids: {
								type: 'posts',
								values: data.pids
							}
						}
					}
					/*
					dis_max: {
						queries: [
							{
								ids: {
									type: 'posts',
									values: data.pids
								}
							},
							{
								match: {
									title: escapeSpecialChars(term)
								}
							}
						]
					}*/
				},
				from: 0,
				size: 20
			}
		};

		Elasticsearch.client.search(query, function(err, obj) {
			if (err) {
				callback(err);
			} else if (obj && obj.hits && obj.hits.hits && obj.hits.hits.length > 0) {
				callback(null, obj.hits.hits.map(function(result) {
					return result._id;
				}));
			} else {
				callback(null, []);
			}
		});
	});
};

Elasticsearch.toggle = function(req, res) {
	if (req.body.state) {
		db.setObjectField('settings:elasticsearch', 'enabled', parseInt(req.body.state, 10) ? '1' : '0', function(err) {
			Elasticsearch.config.enabled = req.body.state;
			res.send(!err ? 200 : 500);
		});
	} else {
		res.send(400, "'state' required");
	}
};

Elasticsearch.add = function(payload, callback) {
	if (!Elasticsearch.client) {
		if (callback) {
			return callback(new Error('not-connected'));
		}
		return;
	}

	if (!payload) {
		if (callback) {
			return callback(null);
		}
		return;
	}

	if (_.isArray(payload)) {
		if (0 === payload.length) {
			if (callback) {
				return callback(null);
			}
			return;
		}
	}
	else {
		// If not array, then make it a single-element array because bulk method requires array.
		payload = [ payload ];
	}

	// Create bulk document, which looks like this:
	/*
	[
	 // action description
	 { index:  { _index: 'myindex', _type: 'mytype', _id: 1 } },
	 // the document to index
	 { title: 'foo' },
	 // action description
	 { update: { _index: 'myindex', _type: 'mytype', _id: 2 } },
	 // the document to update
	 { doc: { title: 'foo' } },
	 // action description
	 { delete: { _index: 'myindex', _type: 'mytype', _id: 3 } },
	 // no document needed for this delete
	]
	*/

	var body = [];
	_.each(payload, function(item) {

		// Make sure id is an integer
		if (_.isString(item.id)) {
			item.id = parseInt(item.id, 10);
		}

		// Action
		body.push({
			index: {
				/*_index: Elasticsearch.config.posts_index_name, */ // We'll set it in bulk()
				/*_type: 'posts', */ // We'll set it in bulk()
				_id: item.id
			}
		});

		// Document
		body.push(item);
	});

	Elasticsearch.client.bulk({
		body: body,
		type: 'posts',
		index: Elasticsearch.config.posts_index_name
	}, function(err, obj) {
		if (err) {
			if (payload.id) {
				winston.error('[plugin/elasticsearch] Could not index post ' + payload.id + ', error: ' + err.message);
			}
			else {
				winston.error('[plugin/elasticsearch] Could not index posts, error: ' + err.message);
			}
		} else if (typeof callback === 'function') {
			callback.apply(arguments);
		}
	});
};

Elasticsearch.remove = function(pid, callback) {
	if (!Elasticsearch.client) {
		return;
	}

	// Make sure id is an integer
	if (_.isString(pid)) {
		pid = parseInt(pid, 10);
	}

	Elasticsearch.client.delete({
		index: Elasticsearch.config.posts_index_name,
		type: 'posts',
		id: pid
	}, function(err, obj) {
		if (err) {
			winston.error('[plugin/elasticsearch] Could not remove post ' + pid + ' from index');
		}

		if (callback) {
			callback(null, obj);
		}
	});
};

Elasticsearch.flush = function(req, res) {
	if (!Elasticsearch.client) {
		return;
	}

	Elasticsearch.client.deleteByQuery({
		index: Elasticsearch.config.posts_index_name,
		type: 'posts',
		q: '*'
	}, function(err, obj){
		if (err) {
			winston.error('[plugin/elasticsearch] Could not empty the search index');
			res.send(500, err.message);
		} else {
			res.send(200);
		}
	});
};

Elasticsearch.post = {};
Elasticsearch.post.save = function(postData) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	Elasticsearch.indexPost(postData);
};

Elasticsearch.post.delete = function(pid, callback) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	Elasticsearch.remove(pid);

	if (typeof callback === 'function') {
		if (!parseInt(Elasticsearch.config.enabled, 10)) {
			return;
		}

		callback();
	}
};

Elasticsearch.post.restore = function(postData) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	Elasticsearch.indexPost(postData);
};

Elasticsearch.post.edit = Elasticsearch.post.restore;

Elasticsearch.topic = {};
Elasticsearch.topic.post = function(topicObj) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	Elasticsearch.indexTopic(topicObj);
};

Elasticsearch.topic.delete = function(tid) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	Elasticsearch.deindexTopic(tid);
};

Elasticsearch.topic.restore = function(topicObj) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	Elasticsearch.indexTopic(topicObj);
};

Elasticsearch.topic.edit = function(topicObj) {
	if (!parseInt(Elasticsearch.config.enabled, 10)) {
		return;
	}

	async.waterfall([
		async.apply(posts.getPostFields, topicObj.mainPid, ['pid', 'content']),
		Elasticsearch.indexPost,
	], function(err, payload) {
		payload.title = topicObj.title;
		Elasticsearch.add(payload);
	});
};

/* Topic and Post indexing methods */

Elasticsearch.indexTopic = function(topicObj, callback) {
	async.waterfall([
		async.apply(topics.getPids, topicObj.tid),
		function(pids, next) {
			// Add OP to the list of pids to index
			if (topicObj.mainPid && pids.indexOf(topicObj.mainPid) === -1) {
				pids.unshift(topicObj.mainPid);
			}

			posts.getPostsFields(pids, ['pid', 'content'], next);
		},
		function(posts, next) {
			async.map(posts, Elasticsearch.indexPost, next);
		}
	], function(err, payload) {
		if (err) {
			winston.error('[plugins/elasticsearch] Encountered an error while compiling post data for tid ' + topicObj.tid);

			if (typeof callback === 'function') {
				return callback(err);
			}
		}

		// Also index the title into the main post of this topic
		for(var x=0,numPids=payload.length;x<numPids;x++) {
			if (payload[x].id === topicObj.mainPid) {
				payload[x].title = topicObj.title;
			}
		}

		if (typeof callback === 'function') {
			// If callback is defined, then we don't index, but rather return the payload?!
			callback(undefined, payload);
		} else {
			Elasticsearch.add(payload, callback);
		}
	});
};


Elasticsearch.deindexTopic = function(tid) {
	async.parallel({
		mainPid: async.apply(topics.getTopicField, tid, 'mainPid'),
		pids: async.apply(topics.getPids, tid)
	}, function(err, data) {

		if (!Elasticsearch.client) {
			return;
		}

		if (data.mainPid && data.pids.indexOf(data.mainPid) === -1) {
			data.pids.unshift(data.mainPid);
		}

		/*
		var query = {
			index: Elasticsearch.config.posts_index_name,
			type: 'posts',
			body: {
				terms: {
					_ids: data.pids
				}
			}
		};
		Elasticsearch.client.deleteByQuery(query, function(err, obj) {
			if (err) {
				winston.error('[plugin/elasticsearch] Encountered an error while deindexing tid ' + tid);
			}
		});
		*/

		async.each(data.pids, function(pid, callback) {
			Elasticsearch.remove(pid, callback);
		}, function(err){
			if (err) {
				winston.error('[plugin/elasticsearch] Encountered an error while deindexing tid ' + tid + '. Error: ' + err.message);
			}
		});

	});
};

Elasticsearch.indexPost = function(postData, callback) {
	if (!postData || !postData.pid || !postData.content) {
		return callback(null);
	}

	var payload = {
		id: postData.pid
	};

	payload.content = postData.content;

	if (typeof callback === 'function') {
		callback(undefined, payload);
	} else {
		Elasticsearch.add(payload);
	}
};

Elasticsearch.deindexPost = Elasticsearch.post.delete;

Elasticsearch.rebuildIndex = function(req, res) {

	async.series([
		Elasticsearch.deleteIndex,
		Elasticsearch.createIndex
	],
	function(err, results){
		if (err) {
			// TODO review this
			winston.error('[plugin/elasticsearch] Could not delete and re-create index. Error: ' + err.message);
			res.sendStatus(500);
			return
		}

		async.waterfall([
			async.apply(db.getSortedSetRange, 'topics:tid', 0, -1),
			function(tids, next) {
				topics.getTopicsFields(tids, ['tid', 'mainPid', 'title'], next);
			}
		], function(err, topics) {
			if (err) {
				return winston.error('[plugins/elasticsearch] Could not retrieve topic listing for indexing. Error: ' + err.message);
			}

			async.map(topics, Elasticsearch.indexTopic, function(err, topicPayloads) {
				var payload = topicPayloads.reduce(function(currentPayload, topics) {
					if (Array.isArray(topics)) {
						return currentPayload.concat(topics);
					} else {
						currentPayload.push(topics);
					}
				}, []).filter(function(entry) {
					return entry.hasOwnProperty('id');
				});

				Elasticsearch.add(payload, function(err, obj) {
					if (!err) {
						res.sendStatus(200);
					}
				});
			});
		});
	});
};

Elasticsearch.createIndex = function(callback) {
	if (!Elasticsearch.client) {
		return callback(new Error('not-connected'));
	}

	var indexName = Elasticsearch.config.posts_index_name;
	if (indexName && 0 < indexName.length) {
		Elasticsearch.client.indices.create({
			index : Elasticsearch.config.posts_index_name,
			body: {
				mappings: {
					posts: {
						properties : {
							content : { type : "string" }, // Post content
							title : { type : "string" } // Topic title
						}
					}
				}
			}
		}, function(err, results){
			if (!err) {
				callback(null, results);
			}
			else if ( /IndexAlreadyExistsException/im.test(err.message) ) { // we can ignore if index is already there
				winston.error("[plugin/elasticsearch] Ignoring error creating mapping " + err);
				callback(null);
			}
			else {
				callback(err);
			}
		});
	}
};

Elasticsearch.deleteIndex = function(callback) {
	if (!Elasticsearch.client) {
		return callback(new Error('not-connected'));
	}

	var indexName = Elasticsearch.config.posts_index_name;
	if (indexName && 0 < indexName.length) {
		Elasticsearch.client.indices.delete({
			index : Elasticsearch.config.posts_index_name
		}, function(err, results) {
			if (!err) {
				callback(null, results);
			}
			else if ( /IndexMissingException/im.test(err.message) ) { // we can ignore if index is not there
				winston.error("[plugin/elasticsearch] Ignoring error deleting mapping " + err);
				callback(null);
			}
			else {
				callback(err);
			}
		});
	}
};

module.exports = Elasticsearch;
