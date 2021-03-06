'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const BasePlatformManager = require('./BasePlatformManager');
const utils = require('../utils');
const assert = require('assert');
const errors = require('../errors');
const cloudController = require('../cf').cloudController;
const logger = require('../logger');
const CONST = require('../constants');
const SecurityGroupNotCreated = errors.SecurityGroupNotCreated;
const SecurityGroupNotFound = errors.SecurityGroupNotFound;
const ordinals = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

class CfPlatformManager extends BasePlatformManager {
  constructor(guid, context) {
    super(guid, context);
    this.space_guid = context.space_guid;
    this.cloudController = cloudController;
  }

  get securityGroupName() {
    return `${CONST.SERVICE_FABRIK_PREFIX}-${this.guid}`;
  }

  postInstanceProvisionOperations(options) {
    return this.createSecurityGroup(options.ipRuleOptions);
  }

  preInstanceDeleteOperations() {
    return this.deleteSecurityGroup();
  }

  postInstanceUpdateOperations(options) {
    return this.ensureSecurityGroupExists(options.ipRuleOptions);
  }

  createSecurityGroup(ruleOptions) {
    const name = this.securityGroupName;
    const rules = _.map(ruleOptions, opts => this.buildSecurityGroupRules(opts));
    logger.info(`Creating security group '${name}' with rules ...`, rules);
    return utils
      .retry(tries => {
        logger.info(`+-> ${ordinals[tries]} attempt to create security group '${name}'...`);
        return this.cloudController
          .createSecurityGroup(name, rules, [this.space_guid])
          .catch(err => {
            logger.error(err);
            throw err;
          });
      }, {
        maxAttempts: 4,
        minDelay: 1000
      })
      .then(securityGroup => securityGroup.metadata.guid)
      .tap(guid => logger.info(`+-> Created security group with guid '${guid}'`))
      .catch(err => {
        logger.error(`+-> Failed to create security group ${name}`);
        logger.error(err);
        throw new SecurityGroupNotCreated(name);
      });
  }

  ensureSecurityGroupExists(ruleOptions) {
    const name = this.securityGroupName;
    logger.info(`Ensuring existence of security group '${name}'...`);
    return this.cloudController
      .findSecurityGroupByName(name)
      .tap(() => logger.info('+-> Security group exists'))
      .catch(SecurityGroupNotFound, () => {
        logger.warn('+-> Security group does not exist. Trying to create it again.');
        return this.ensureTenantId(this.space_guid)
          .then(() => this.createSecurityGroup(ruleOptions));
      });
  }

  deleteSecurityGroup() {
    const name = this.securityGroupName;
    logger.info(`Deleting security group '${name}'...`);
    return this.cloudController
      .findSecurityGroupByName(name)
      .tap(securityGroup => assert.strictEqual(securityGroup.entity.name, name))
      .then(securityGroup => securityGroup.metadata.guid)
      .tap(guid => logger.info(`+-> Found security group with guid '${guid}'`))
      .then(guid => this.cloudController.deleteSecurityGroup(guid))
      .tap(() => logger.info('+-> Deleted security group'))
      .catch(SecurityGroupNotFound, err => {
        logger.warn('+-> Could not find security group');
        logger.warn(err);
      }).catch(err => {
        logger.error('+-> Failed to delete security group');
        logger.error(err);
        throw err;
      });
  }

  ensureTenantId(space_guid) {
    return Promise
      .try(() => space_guid ? space_guid : this.cloudController
        .getServiceInstance(this.guid)
        .then(instance => instance.entity.space_guid)
      );
  }

  buildSecurityGroupRules(options) {
    return {
      protocol: options.protocol,
      destination: _.size(options.ips) === 1 ? `${_.first(options.ips)}` : `${_.first(options.ips)}-${_.last(options.ips)}`,
      ports: _.size(options.ports) === 1 ? `${_.first(options.ports)}` : `${_.first(options.ports)}-${_.last(options.ports)}`
    };
  }
}

module.exports = CfPlatformManager;