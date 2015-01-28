<h1><i class="fa fa-search"></i> Elasticsearch</h1>

<div class="row">
	<div class="col-sm-8">
		<h2>Client Configuration</h2>
		<form role="form" class="elasticsearch-settings">
			<div class="form-group">
				<label for="host">Host</label>
				<input class="form-control" type="text" name="host" id="host" placeholder="Default: 127.0.0.1:9200" />
				<p class="help-block">
					Host can be:
					<ul>
						<li>Single host:port
							<pre>localhost:9200</pre>
						</li>
						<li>Multiple comma separate host:port pairs
							<pre>host1:9200,host2:9200</pre>
						</li>
						<li>Multiple full urls separated by comma
							<pre>http://host1:9200,http://host2:9200</pre>
						</li>
						<li>Multiple full urls (with basic auth credentials) separated by comma
							<pre>https://user:pass@host1:9200,https://user:pass@host2:9200</pre>
						</li>
					</ul>
				</p>
			</div>

			<h4>Indexing Settings</h4>
			<div class="form-group">
				<label for="index_name">Index Name</label>
				<input class="form-control" type="text" name="index_name" id="index_name" placeholder="Default: nodebb"/>
			</div>
			<div class="form-group">
				<label for="post_type">Post Type</label>
				<input class="form-control" type="text" name="post_type" id="post_type" placeholder="Default: posts" />
			</div>
			<div class="form-group">
				<label for="post_type">Batch Index Size</label>
				<input class="form-control" type="text" name="batch_size" id="batch_size" placeholder="Default: 1000" />
			</div>
			<button id="save" type="button" class="btn btn-primary btn-block">Save</button>
		</form>

		<h2>Advanced Options</h2>
		<button class="btn btn-success" data-action="rebuild">Rebuild Search Index</button>
		<p class="help-block">
			This option reads every topic and post saved in the database and adds it to the search index.
			Any topics already indexed will have their contents replaced, so there is no need to flush
			the index prior to re-indexing.
		</p>
		<button class="btn btn-danger" data-action="flush">Flush Search Index</button>
		<p class="help-block">
			Flushing the search index will remove all references to searchable assets
			in the Elasticsearch backend, and your users will no longer be able to search for
			topics. New topics and posts made after a flush will still be indexed.
		</p>
	</div>
	<div class="col-sm-4">
		<div class="panel panel-default">
			<div class="panel-heading">
				<h3 class="panel-title">
					<!-- IF ping -->
					<i class="fa fa-circle text-success"></i> Connected
					<!-- ELSE -->
					<i class="fa fa-circle text-danger"></i> Not Connected
					<!-- ENDIF ping -->
				</h3>
			</div>
			<div class="panel-body">
				<!-- IF ping -->
				<p>
					Successfully connected to the Elasticsearch search engine.
				</p>
				<!-- ELSE -->
				<p>
					Could not establish a connection to the Elasticsearch search engine.
				</p>
				<p>
					Please ensure your configuration settings are correct.
				</p>
				<!-- ENDIF ping -->

				<!-- IF enabled -->
				<button class="btn btn-success btn-block" data-action="toggle" data-enabled="1"><i class="fa fa-fw fa-play"></i> &nbsp; Indexing Enabled</button>
				<p class="help-block">
					Topics and Posts will be automatically added to the search index.
				</p>
				<!-- ELSE -->
				<button class="btn btn-warning btn-block" data-action="toggle" data-enabled="0"><i class="fa fa-fw fa-pause"></i> &nbsp; Indexing Disabled</button>
				<p class="help-block">
					Indexing is currently paused, Topics and Posts will not be automatically added to the search index.
				</p>
				<!-- ENDIF enabled -->
			</div>
		</div>
		<div class="panel panel-default">
			<div class="panel-heading">
				<h3 class="panel-title">
					Statistics
				</h3>
			</div>
			<div class="panel-body">
				<!-- IF stats -->
				<ul>
					<li>Total items indexed: {stats.total}</li>
					<li>Topics indexed: {stats.topics}</li>
				</ul>
				<!-- ELSE -->
				<p>
					There are no statistics to report.
				</p>
				<!-- ENDIF stats -->
			</div>
		</div>
	</div>
</div>
<script>
	$(document).ready(function() {
		var	csrf = '{csrf}' || $('#csrf_token').val();

		// Flush event
		$('button[data-action="flush"]').on('click', function() {
			bootbox.confirm('Are you sure you wish to empty the Elasticsearch search index?', function(confirm) {
				if (confirm) {
					$.ajax({
						url: config.relative_path + '/admin/plugins/elasticsearch/flush',
						type: 'DELETE',
						data: {
							_csrf: csrf
						}
					}).success(function() {
						ajaxify.refresh();

						app.alert({
							type: 'success',
							alert_id: 'elasticsearch-flushed',
							title: 'Search index flushed',
							timeout: 2500
						});
					});
				}
			});
		});

		// Toggle event
		$('button[data-action="toggle"]').on('click', function() {
			$.ajax({
				url: config.relative_path + '/admin/plugins/elasticsearch/toggle',
				type: 'POST',
				data: {
					_csrf: csrf,
					state: parseInt($('button[data-action="toggle"]').attr('data-enabled'), 10) ^ 1
				}
			}).success(ajaxify.refresh);
		});

		// Index All event
		$('button[data-action="rebuild"]').on('click', function() {
			bootbox.confirm('Rebuild search index?', function(confirm) {
				if (confirm) {
					app.alert({
						type: 'info',
						alert_id: 'elasticsearch-rebuilt',
						title: '<i class="fa fa-refresh fa-spin"></i> Rebuilding search index...'
					});

					$.ajax({
						url: config.relative_path + '/admin/plugins/elasticsearch/rebuild',
						type: 'POST',
						data: {
							_csrf: csrf
						}
					}).success(function() {
						ajaxify.refresh();

						app.alert({
							type: 'success',
							alert_id: 'elasticsearch-rebuilt',
							title: 'Search index rebuilt',
							timeout: 2500
						});
					});
				}
			});
		});

		// Settings form event
		require(['settings'], function(Settings) {
			Settings.load('elasticsearch', $('.elasticsearch-settings'));

			$('#save').on('click', function() {
				Settings.save('elasticsearch', $('.elasticsearch-settings'), function() {
					app.alert({
						type: 'success',
						alert_id: 'elasticsearch-saved',
						title: 'Settings Saved',
						message: 'Click here to reload.',
						timeout: 2500,
						clickfn: function() {
							socket.emit('admin.reload');
						}
					});
				});
			});
		});
	});
</script>