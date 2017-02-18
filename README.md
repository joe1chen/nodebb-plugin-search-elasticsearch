# Elasticsearch Search for NodeBB

This plugin extends NodeBB to utilise an installation of Elasticsearch as a search backend.

## Configuration

1. Install this plugin via npm: `npm install nodebb-plugin-search-elasticsearch`
1. Activate it in the Plugins page
1. Restart NodeBB
1. Check that the plugin has successfully connected to the search engine. If not, adjust as necessary.

## Installation

    npm install nodebb-plugin-search-elasticsearch
    
##  Modification 
1. fixed the bug of latest version of elasticsearch api (^12.x.x) 
2. fixed searcingh result id error 

##TODO
1. fixation of the bug which searchTopic method does not called by filer:topic.search hook properly  
2. getTopicCount method cannot get the inner value of a nested json object 
