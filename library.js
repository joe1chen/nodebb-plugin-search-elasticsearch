"use strict";

/* globals module, require */

var db = module.parent.require('./database'),
	winston = module.parent.require('winston'),
	elasticsearch = require('elasticsearch'),
	async = module.parent.require('async'),

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
			host: localhost
			port: 9200
			enabled: undefined (false)
		*/
		config: {
			sniffOnStart: true,             // Should the client attempt to detect the rest of the cluster when it is first instantiated?
			sniffInterval: 60000,           // Every n milliseconds, perform a sniff operation and make sure our list of nodes is complete.
			sniffOnConnectionFault: true    // Should the client immediately sniff for a more current list of nodes when a connection dies?
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
	Elasticsearch.client.count({
		index: Elasticsearch.config.index_name
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
	/*
	var query = Elasticsearch.client.createQuery().q((Elasticsearch.config['titleField'] || 'title_t') + ':*').start(0).rows(0);

	Elasticsearch.client.search(query, function(err, obj) {
		if (!err && obj && obj.response) {
			callback(undefined, obj.response.numFound);
		} else {
			callback(err, 0);
		}
	});
	*/
};

Elasticsearch.connect = function() {
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
		var fields = {},
			query;

		// TODO
		/*
		// Populate Fields
		fields[Elasticsearch.config['titleField'] || 'title_t'] = 1.5;
		fields[Elasticsearch.config['contentField'] || 'description_t'] = 1;

		query = Elasticsearch.client.createQuery().q(data.query).dismax().qf(fields).start(0).rows(20);

		Elasticsearch.client.search(query, function(err, obj) {
			if (err) {
				callback(err);
			} else if (obj && obj.response && obj.response.docs.length > 0) {
				var payload = obj.response.docs.map(function(result) {
						return result.id;
					});

				callback(null, payload);
				cache.set(data.query, payload);
			} else {
				callback(null, []);
				cache.set(data.query, []);
			}
		});
		*/
	}
};

Elasticsearch.searchTopic = function(data, callback) {
	var tid = data.tid,
		term = data.term;

	async.parallel({
		mainPid: async.apply(topics.getTopicField, tid, 'mainPid'),
		pids: async.apply(topics.getPids, tid)
	}, function(err, data) {
		data.pids.unshift(data.mainPid);

		var fields = {},
			query;

		// Populate Query

		/*
		fields[Elasticsearch.config.contentField || 'description_t'] = escapeSpecialChars(term);
		fields.id = '(' + data.pids.join(' OR ') + ')';

		query = Elasticsearch.client.createQuery().q(fields);

		Elasticsearch.client.search(query, function(err, obj) {
			if (err) {
				callback(err);
			} else if (obj && obj.response && obj.response.docs.length > 0) {
				callback(null, obj.response.docs.map(function(result) {
					return result.id;
				}));
			} else {
				callback(null, []);
			}
		});
		*/
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
	Elasticsearch.client.add(payload, function(err, obj) {
		if (err) {
			winston.error('[plugin/elasticsearch] Could not index post ' + payload.id + ', error: ' + err.message);
		} else if (typeof callback === 'function') {
			callback.apply(arguments);
		}
	});
};

Elasticsearch.remove = function(pid) {
	Elasticsearch.client.delete('id', pid, function(err, obj) {
		if (err) {
			winston.error('[plugin/elasticsearch] Could not remove post ' + pid + ' from index');
		}
	});
};

Elasticsearch.flush = function(req, res) {
	Elasticsearch.client.delete('id', '*', function(err, obj){
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
		async.apply(posts.getPostFields,topicObj.mainPid, ['pid', 'content']),
			Elasticsearch.indexPost,
		], function(err, payload) {
		payload[Elasticsearch.config['titleField'] || 'title_t'] = topicObj.title;
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
			winston.error('[plugins/elasticsearch] Encountered an error while compiling post data for tid ' + tid);

			if (typeof callback === 'function') {
				return callback(err);
			}
		}

		// Also index the title into the main post of this topic
		for(var x=0,numPids=payload.length;x<numPids;x++) {
			if (payload[x].id === topicObj.mainPid) {
				payload[x][Elasticsearch.config['titleField'] || 'title_t'] = topicObj.title;
			}
		}

		if (typeof callback === 'function') {
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
		data.pids.unshift(data.mainPid);
		var query = 'id:(' + data.pids.join(' OR ') + ')';
		Elasticsearch.client.deleteByQuery(query, function(err, obj) {
			if (err) {
				winston.error('[plugin/elasticsearch] Encountered an error while deindexing tid ' + tid);
			}
		});
	});
};

Elasticsearch.indexPost = function(postData, callback) {
	var payload = {
			id: postData.pid
		};

	
	payload[Elasticsearch.config['contentField'] || 'description_t'] = postData.content;

	if (typeof callback === 'function') {
		callback(undefined, payload);
	} else {
		Elasticsearch.add(payload);
	}
	
};

Elasticsearch.deindexPost = Elasticsearch.post.delete;

Elasticsearch.rebuildIndex = function(req, res) {
	db.getSortedSetRange('topics:tid', 0, -1, function(err, tids) {
		if (err) {
			winston.error('[plugin/elasticsearch] Could not retrieve topic listing for indexing');
		} else {
			async.map(tids, Elasticsearch.indexTopic, function(err, topicPayloads) {
				var payload = [];
				for(var x=0,numTopics=topicPayloads.length;x<numTopics;x++) {
					payload = payload.concat(topicPayloads[x]);
				}

				Elasticsearch.add(payload, function(err, obj) {
					if (!err) {
						res.send(200);
					}
				});
			});
		}
	});
};

module.exports = Elasticsearch;
