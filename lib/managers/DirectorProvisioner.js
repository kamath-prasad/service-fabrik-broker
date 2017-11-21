'use strict';

const assert = require('assert');
const _ = require('lodash');
const Promise = require('bluebird');
const errors = require('../errors');
const utils = require('../utils');
const catalog = require('../models/catalog');
const resourceManager = require('../resourcemanager');
const logger = require('../logger');
const fabrik = require('../fabrik');
const BaseManager = require('./BaseManager');

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');


class DirectorProvisioner extends BaseManager {

  registerServices(provisionerType) {
    const filename = path.join(__dirname, '..', '..', 'config', `${provisionerType}-services.yml`);
    const buffer = fs.readFileSync(filename, 'utf8');
    const context = {
      require: require,
      __filename: filename,
      __dirname: path.dirname(filename),
      base64_template: function (prefix) {
        const template = path.join(this.__dirname, 'templates', `${prefix}-manifest.yml.ejs`);
        return fs.readFileSync(template).toString('base64');
      },
      certificate: function (name) {
        const filename = path.join(this.__dirname, 'certs', name);
        return JSON.stringify(fs.readFileSync(filename).toString('ascii'));
      }
    };
    const config = yaml.safeLoad(_.template(buffer)(context));
    _.map(config.services, function (service) {
      const serviceAttribues = _.omit(service, 'plans');
      const servicePlans = service.plans;
      resourceManager.manager.registerServices(provisionerType, service.name, serviceAttribues, servicePlans);
    });

  }

  registerWatcher() {
    resourceManager.manager.getAllServices()
      .then(services => {
        logger.info('Services are ', services);
        resourceManager.manager.registerWatcher('deployments/director', this.worker, true);
      })
  }

  worker(change) {
    const changedKey = change.node.key;
    logger.info('Changed key is : ', changedKey);
    logger.info('Changed key is : ', _.split(changedKey, '/').length);
    let keys = _.split(changedKey, '/');
    if (keys.length == 5 && keys[4] == 'options') {
      logger.info('Match found');
      const changedValue = JSON.parse(change.node.value);
      logger.info('Values are : ', changedValue);
      const serviceId = changedValue.service_id;
      const planId = changedValue.plan_id;
      const plan = catalog.getPlan(planId);
      const instanceId = changedValue.instance_id;
      return Promise.try(() => {
        assert.strictEqual(serviceId, plan.service.id);
        return fabrik.createManager(plan);
      }).then(manager => {
        return manager.createInstance(instanceId);
      }).then(instance => {
        return instance.create(changedValue.parameters);
      });
    }
  }


}

module.exports = DirectorProvisioner;