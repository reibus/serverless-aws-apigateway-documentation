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

/**
 * maps requests to delete to an array containing the promise and the body of the request
 * @param {aws} provider
 * @param {documentationPieces} Object, contains documentationToUpsert and documentationToDelete
 * @returns request type array
 */
function createDocumentationRequests(aws, { documentationToUpsert, documentationToDelete }) {
  let requests = []
  // delete documentation parts
  requests = requests.concat(
    documentationToDelete.map(part => {
      return{ 
        request: aws.request('APIGateway', 'deleteDocumentationPart', {
          documentationPartId: part.id,
          restApiId: part.restApiId,
        }),
        part
      }
    })
  )
  // upsert documentation parts
  requests = requests.concat(
    documentationToUpsert.map(part => {
      return {
        request: aws.request('APIGateway', 'createDocumentationPart', {
          ...part,
          properties: JSON.stringify(part.properties)
        }),
        part
      }
    })
  )
  return requests
}

/**
 * Resolves all documentation part requests and ignores duplicates 
 * @param requests Object Array 
 */
async function resolveDocumentationRequests(requests) {
  console.log("---- resolveDocumentationRequests ----");
  let duplicates = 0
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index];
    request.request
      .then()
      .catch((error) => {
        if (error.providerErrorCodeExtension === "CONFLICT_EXCEPTION") {
          duplicates = duplicates + 1
        } else {
          throw error
        }
      })
  }
  console.log("Duplicate pieces of documentation: ", duplicates)
  return Promise.resolve()
}

/*
 * Different types support different extra properties beyond
 * the basic ones, so we need to make sure we only look for
 * the appropriate properties.
 */
function determinePropertiesToGet (type) {
  const defaultProperties = ['description', 'summary', 'delete']
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

function prepareDocumentationParts(futureParts, currentParts ) {
  return futureParts.reduce((prev, { restApiId, location, properties }, i) => {
    const hasPart = currentParts.find((part) => {
      const locationPath = location.path ? `/${location.path}` : undefined
      return part.location && part.location.type === location.type &&
      part.location.path === locationPath &&
      part.location.method === location.method &&
      part.location.statusCode === location.statusCode && 
      part.location.name === location.name
    });
    if (hasPart) {
      if (JSON.parse(hasPart.properties).delete) {
        prev.toDelete.push({ id: hasPart.id, restApiId });
        return prev
      } else{
        if (JSON.stringify(properties) !== hasPart.properties) {
          prev.toDelete.push({ id: hasPart.id, restApiId });
          prev.toUpload.push({ location, properties, restApiId });
        }
      }
    } else {
      if (!properties.delete) {
        prev.toUpload.push({ location, properties, restApiId });
      }
    }
    return prev
  }, { toDelete: [], toUpload: [] })
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
      console.log("----- _updateDocumentationAsync -----");
      const aws = this.serverless.providers.aws;
      const update = this.customVars.documentation.update;
      const concurrency = this.customVars.documentation.concurrency || 100;
      let createVersion = false;
      let documentationToUpsert = this.documentationParts
      let documentationToDelete = []
      try {
        await aws.request('APIGateway', 'getDocumentationVersion', {
          restApiId: this.restApiId,
          documentationVersion: this.getDocumentationVersion(),
        });
      } catch (err) {
        if (err.providerError && err.providerError.statusCode === 404) {
          createVersion = true;
        }
        return Promise.reject(err);
      }
      let documentationParts = await getDocumentationPartsPromise(aws, this.restApiId);
      if (update) {
        const { toDelete, toUpload } = prepareDocumentationParts(this.documentationParts, documentationParts)
        documentationToDelete = toDelete;
        documentationToUpsert = toUpload;
      }
      let requests = createDocumentationRequests(aws, {
        documentationToUpsert,
        documentationToDelete
      })
      
      try {
        console.log("sending documentation requests");
        console.log("documentation request concurrency: ", concurrency);
        let i = 0
        while (requests.length) {
          i += 1
          console.log("iterations: ", i);
          await resolveDocumentationRequests(requests.splice(0, concurrency))     
        }
      } catch (error) {
        console.error("error in updating documentation", error);
      }
      console.log("finished documentation requests");

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
