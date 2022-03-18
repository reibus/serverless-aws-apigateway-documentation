'use strict';

const objectHash = require('object-hash');

const globalDocumentationParts = require('./globalDocumentationParts.json');
const functionDocumentationParts = require('./functionDocumentationParts.json');

const untoldPart = ['API', 'MODEL'];

function getDocumentationProperties(def, propertiesToGet) {
  const docProperties = new Map();
  propertiesToGet.forEach((key) => {
    if (def[key]) {
      docProperties.set(key, def[key]);
    }
  });
  return docProperties;
}

function _mapToObj(map) {
  const returnObj = {};
  map.forEach((val, key) => {
    returnObj[key] = val;
  });

  return returnObj;
}

/*
 * Different types support different extra properties beyond
 * the basic ones, so we need to make sure we only look for
 * the appropriate properties.
 */
function determinePropertiesToGet (type) {
  const defaultProperties = ['description', 'summary']
  let result = defaultProperties
  switch (type) {
    case 'API':
      result.push('tags', 'info')
      break
    case 'METHOD':
      result.push('tags')
      break
  }
  return result

}

function prepareDocumentationParts(remoteDocumentationParts, currentParts ) {
  // find existing pieces and new pieces of the documentation

  let localDocumentationParts = remoteDocumentationParts.reduce((prev, { restApiId, location, properties }) => {
    const hasPart = currentParts.find((part) => {
      return part.location && part.location.type === location.type &&
        part.location.path === `/${location.path}` &&
        part.location.method === location.method &&
        part.location.statusCode === location.statusCode && 
        part.location.name === location.name
    });

    if (hasPart) {
      if (JSON.stringify(properties) !== hasPart.properties) {
        prev.toDelete.push({ id: hasPart.id });
        prev.toUpload.push({ location, properties, restApiId });
      }
    } else {
      prev.toUpload.push({ location, properties, restApiId });
    }

    return prev
  }, { toDelete: [], toUpload: [] })

  // find pieces of the documentation to delete
  localDocumentationParts = currentParts.reduce((prev, { id, location }) => {
    const hasPart = remoteDocumentationParts.find((part) => {
      return part.location && part.location.type === location.type &&
        part.location.path === `/${location.path}` &&
        part.location.method === location.method &&
        part.location.statusCode === location.statusCode && 
        part.location.name === location.name
    });

    if (!hasPart) {
      prev.toDelete.push({ id });
    }

    return prev
  }, localDocumentationParts)

  return localDocumentationParts
}

function getDocumentationMethods(documentationParts) {
  return documentationParts.filter(part => part && part.location && !untoldPart.includes(part.location.type));
}

async function getDocumentationPartsPromise(aws, restApiId) {
  let documentationResults = [];
  let prevPosition;
  let response;
  do {
    const data = {
      restApiId: restApiId,
      limit: 500,
    }
    if (prevPosition) {
      data.position = prevPosition
    }
    response = await aws.request('APIGateway', 'getDocumentationParts', data);

    documentationResults = response.items.length ? [ ...documentationResults, ...response.items ] : documentationResults
    prevPosition = response.position;
  } while(!!response.position)

  return documentationResults
}

var autoVersion;

module.exports = function() {
  return {
    _createDocumentationPart: function _createDocumentationPart(part, def, knownLocation) {
      const location = part.locationProps.reduce((loc, property) => {
        loc[property] = knownLocation[property] || def[property];
        return loc;
      }, {});
      location.type = part.type;
      const propertiesToGet = determinePropertiesToGet(location.type)

      const props = getDocumentationProperties(def, propertiesToGet);
      if (props.size > 0) {
        this.documentationParts.push({
          location,
          properties: _mapToObj(props),
          restApiId: this.restApiId,
        });
      }

      if (part.children) {
        this.createDocumentationParts(part.children, def, location);
      }
    },

    createDocumentationPart: function createDocumentationPart(part, def, knownLocation) {
      if (part.isList) {
        if (!(def instanceof Array)) {
          const msg = `definition for type "${part.type}" is not an array`;
          console.info('-------------------');
          console.info(msg);
          throw new Error(msg);
        }

        def.forEach((singleDef) => this._createDocumentationPart(part, singleDef, knownLocation));
      } else {
        this._createDocumentationPart(part, def, knownLocation);
      }
    },

    createDocumentationParts: function createDocumentationParts(parts, def, knownLocation) {
      Object.keys(parts).forEach((part) => {
        if (def[part]) {
          this.createDocumentationPart(parts[part], def[part], knownLocation);
        }
      });
    },
    _updateDocumentationAsync: async function _updateDocumentationAsync() {
      const update = this.customVars.documentation.update;
      let createVersion = false;
      const aws = this.serverless.providers.aws;
      
      try {
        const documentationVersion = this.getDocumentationVersion()
        await aws.request('APIGateway', 'getDocumentationVersion', {
          restApiId: this.restApiId,
          documentationVersion,
        });
      } catch (err) {
        if (err.providerError && err.providerError.statusCode === 404) {
          console.info("Creating new documentation version")
          createVersion = true;
        }
        else {
          return Promise.reject(err);
        }
      }

      let results = await getDocumentationPartsPromise(aws, this.restApiId);
      if (update) {
        const { toDelete, toUpload } = prepareDocumentationParts(this.documentationParts, results)
        results = toDelete;
        this.documentationParts = toUpload;
      }
      const deleteDocumentationParts = results.map(part => aws.request('APIGateway', 'deleteDocumentationPart', {
        documentationPartId: part.id,
        restApiId: this.restApiId,
      }))

      await Promise.all(deleteDocumentationParts);

      await this.documentationParts.reduce((promise, part) => {
        return promise.then(() => {
          part.properties = JSON.stringify(part.properties);
          return aws.request('APIGateway', 'createDocumentationPart', part);
        });
      }, Promise.resolve())

      const methodsParts = getDocumentationMethods(this.documentationParts);
      return createVersion && methodsParts.length ? aws.request('APIGateway', 'createDocumentationVersion', {
         restApiId: this.restApiId,
          documentationVersion: this.getDocumentationVersion(),
          stageName: this.options.stage,
        }): Promise.resolve();
    },

    getGlobalDocumentationParts: function getGlobalDocumentationParts() {
      const globalDocumentation = this.customVars.documentation;
      this.createDocumentationParts(globalDocumentationParts, globalDocumentation, {});
    },

    getFunctionDocumentationParts: function getFunctionDocumentationParts() {
      const httpEvents = this._getHttpEvents();
      Object.keys(httpEvents).forEach(funcNameAndPath => {
        const httpEvent = httpEvents[funcNameAndPath];
        const path = httpEvent.path;
        const method = httpEvent.method.toUpperCase();
        this.createDocumentationParts(functionDocumentationParts, httpEvent, { path, method });
      });
    },

    _getHttpEvents: function _getHttpEvents() {
      return this.serverless.service.getAllFunctions().reduce((documentationObj, functionName) => {
        const func = this.serverless.service.getFunction(functionName);
        func.events
          .filter((eventTypes) => eventTypes.http && eventTypes.http.documentation)
          .map((eventTypes) => eventTypes.http)
          .forEach(currEvent => {
            let key = functionName + currEvent.method + currEvent.path;
            documentationObj[key] = currEvent;
          });
        return documentationObj;
      }, {});
    },

    generateAutoDocumentationVersion: function generateAutoDocumentationVersion() {
      const versionObject = {
        globalDocs: this.customVars.documentation,
        functionDocs: {},
      }

      const httpEvents = this._getHttpEvents();
      Object.keys(httpEvents).forEach(funcName => {
        versionObject.functionDocs[funcName] = httpEvents[funcName].documentation;
      });

      autoVersion = objectHash(versionObject);
      console.info("New Documentation version: ", autoVersion)
      return autoVersion;
    },

    getDocumentationVersion: function getDocumentationVersion() {
      return this.customVars.documentation.version || autoVersion || this.generateAutoDocumentationVersion();
    },

    _buildDocumentation: async function _buildDocumentation(result) {
      this.restApiId = result.Stacks[0].Outputs
        .filter(output => output.OutputKey === 'AwsDocApiId')
        .map(output => output.OutputValue)[0];

      this.getGlobalDocumentationParts();
      this.getFunctionDocumentationParts();

      if (this.options.noDeploy) {
        console.info('-------------------');
        console.info('documentation parts:');
        console.info(this.documentationParts);
        return;
      }

      return this._updateDocumentationAsync();
    },

    addDocumentationToApiGateway: function addDocumentationToApiGateway(resource, documentationPart, mapPath) {
      if (documentationPart && Object.keys(documentationPart).length > 0) {
        if (!resource.Properties.RequestParameters) {
          resource.Properties.RequestParameters = {};
        }

        documentationPart.forEach(function(qp) {
          const source = `method.request.${mapPath}.${qp.name}`;
          if (resource.Properties.RequestParameters.hasOwnProperty(source)) return; // don't mess with existing config
          resource.Properties.RequestParameters[source] = qp.required || false;
        });
      }
    },

    updateCfTemplateFromHttp: function updateCfTemplateFromHttp(eventTypes) {
      if (eventTypes.http && eventTypes.http.documentation) {
        const resourceName = this.normalizePath(eventTypes.http.path);
        const methodLogicalId = this.getMethodLogicalId(resourceName, eventTypes.http.method);
        const resource = this.cfTemplate.Resources[methodLogicalId];

        resource.DependsOn = new Set();
        this.addMethodResponses(resource, eventTypes.http.documentation);
        this.addRequestModels(resource, eventTypes.http.documentation);

        if (!this.options['doc-safe-mode']) {
          this.addDocumentationToApiGateway(
            resource,
            eventTypes.http.documentation.requestHeaders,
            'header'
          );
          this.addDocumentationToApiGateway(
            resource,
            eventTypes.http.documentation.queryParams,
            'querystring'
          );
          this.addDocumentationToApiGateway(
              resource,
              eventTypes.http.documentation.pathParams,
              'path'
          );
        }
        resource.DependsOn = Array.from(resource.DependsOn);
        if (resource.DependsOn.length === 0) {
          delete resource.DependsOn;
        }
      }
    },

    _getDocumentationProperties: getDocumentationProperties
  };
};
