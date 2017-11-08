'use strict';

const assert = require('assert');
const Promise = require('bluebird');
const _ = require('lodash');
const yaml = require('js-yaml');
const BaseInstance = require('./BaseInstance');
const config = require('../config');
const logger = require('../logger');
const errors = require('../errors');
const jwt = require('../jwt');
const utils = require('../utils');
const NotFound = errors.NotFound;
const ServiceInstanceNotFound = errors.ServiceInstanceNotFound;
const SecurityGroupNotCreated = errors.SecurityGroupNotCreated;
const ScheduleManager = require('../jobs');
const CONST = require('../constants');

class DirectorInstance extends BaseInstance {
  constructor(guid, manager) {
    super(guid, manager);
    this.networkSegmentIndex = undefined;
  }

  static get typeDescription() {
    return 'deployment';
  }

  get deploymentName() {
    return this.manager.getDeploymentName(this.guid, this.networkSegmentIndex);
  }

  get async() {
    return this.operation !== CONST.OPERATION_TYPE.BACKUP && this.operation !== CONST.OPERATION_TYPE.UNLOCK;
    //Backup/Unlock operation is being turned into SYNCH and behind scenese polling will happen to status check.
    //Rationale : Bind operations can happen while backups are happening.
  }

  initialize(operation) {
    return Promise
      .try(() => {
        this.operation = operation.type;
        if (operation.type === 'create') {
          return this.manager.aquireNetworkSegmentIndex(this.guid);
        }
        return this.manager.findNetworkSegmentIndex(this.guid);
      })
      .tap(networkSegmentIndex => {
        assert.ok(_.isInteger(networkSegmentIndex), `Network segment index '${networkSegmentIndex}' must be an integer`);
        this.networkSegmentIndex = networkSegmentIndex;
      })
      .tap(() => {
        if (operation.type === 'delete') {
          return Promise
            .all([
              this.deleteSecurityGroup(),
              this.ensureSpaceGuid()
              .then(space_guid => this.manager.deleteRestoreFile(space_guid, this.guid))
              .catch(err => {
                logger.error(`Failed to delete restore file of instance '${this.guid}'`);
                logger.error(err);
                throw err;
              }),
              //ScheduledBackupJob is not being cancelled on delete, rather BackupJob itself takes care of it
            ]);
        }
      });
  }

  finalize(operation) {
    const action = _.capitalize(operation.type);
    return Promise
      .try(() => {
        switch (operation.type) {
        case 'create':
          return this
            .createSecurityGroup(operation.space_guid)
            .tap(() => operation.state === CONST.OPERATION.SUCCEEDED ? this.scheduleAutoUpdate() : {});
        case 'update':
          return this.ensureSecurityGroupExists();
        }
      })
      .catch(SecurityGroupNotCreated, err => _.assign(operation, {
        state: 'failed',
        description: `${action} deployment '${this.deploymentName}' not yet completely succeeded because "${err.message}"`
      }));
  }

  create(params) {
    const operation = {
      type: 'create'
    };
    return this
      .initialize(operation)
      .then(() => this.manager.executePreDeploymentSteps(this.deploymentName))
      .then(preDeps => this.manager
        .createOrUpdateDeployment(this.deploymentName, params, null, preDeps)
      )
      .then(taskId => _
        .chain(operation)
        .assign(_.pick(params, 'parameters', 'space_guid'))
        .set('task_id', taskId)
        .value()
      );
  }

  update(params) {
    const operation = {
      type: 'update'
    };
    // service fabrik operation token
    const token = _.get(params.parameters, 'service-fabrik-operation', null);
    if (token) {
      _.unset(params.parameters, 'service-fabrik-operation');
    }
    return this
      .initialize(operation)
      .then(() => token ? jwt.verify(token, config.password) : null)
      .then(serviceFabrikOperation => {
        logger.info('SF Operation input:', serviceFabrikOperation);
        this.operation = _.get(serviceFabrikOperation, 'name', 'update');
        const deploymentLockPromise = (this.operation === CONST.OPERATION_TYPE.UNLOCK) ?
          Promise.resolve({}) :
          Promise.try(() => this.manager.verifyDeploymentLockStatus(this.deploymentName));
        return deploymentLockPromise.return(serviceFabrikOperation);
      })
      .then(serviceFabrikOperation => {
        // normal update operation
        if (this.operation === 'update') {
          const args = _.get(serviceFabrikOperation, 'arguments');
          return this.manager
            .createOrUpdateDeployment(this.deploymentName, params, args)
            .then(taskId => _
              .chain(operation)
              .assign(_.pick(params, 'parameters'))
              .set('task_id', taskId)
              .value()
            );
        }
        // service fabrik operation
        const previousValues = params.previous_values;
        const opts = _
          .chain(previousValues)
          .pick('plan_id', 'service_id')
          .set('space_guid', previousValues.space_id)
          .set('organization_guid', previousValues.organization_id)
          .set('instance_guid', this.guid)
          .set('deployment', this.deploymentName)
          .assign(_.omit(serviceFabrikOperation, 'name'))
          .value();
        return this.manager
          .invokeServiceFabrikOperation(this.operation, opts)
          .then(result => _
            .chain(operation)
            .assign(result)
            .set('username', serviceFabrikOperation.username)
            .set('useremail', serviceFabrikOperation.useremail)
            .value()
          );
      });
  }

  delete(params) {
    const operation = {
      type: 'delete'
    };
    return this
      .initialize(operation)
      .then(() => this.manager.verifyDeploymentLockStatus(this.deploymentName))
      .then(() => this.manager.deleteDeployment(this.deploymentName, params))
      .then(taskId => _
        .chain(operation)
        .set('task_id', taskId)
        .value()
      );
  }

  lastOperation(operation) {
    if (operation.type === 'update' && _.has(operation, 'subtype')) {
      logger.info('Fetching state of last service fabrik operation', operation);
      return this.manager
        .getServiceFabrikOperationState(operation.subtype, _
          .chain(operation)
          .omit('subtype')
          .set('instance_guid', this.guid)
          .value()
        );
    }
    logger.info('Fetching state of last operation', operation);
    return Promise
      .try(() => {
        assert.ok(operation.task_id, 'Operation must have the property \'task_id\'');
        return this.manager.getTask(operation.task_id);
      })
      .catchThrow(NotFound, new ServiceInstanceNotFound(this.guid))
      .then(task => {
        assert.ok(_.endsWith(task.deployment, this.guid), `Deployment '${task.deployment}' must end with '${this.guid}'`);
        this.networkSegmentIndex = this.manager.getNetworkSegmentIndex(task.deployment);
        this.setOperationState(operation, task);
        if (operation.state !== 'in progress') {
          return this.finalize(operation);
        }
      })
      .return(operation);
  }

  setOperationState(operation, task) {
    const action = _.capitalize(operation.type);
    const timestamp = new Date(task.timestamp * 1000).toISOString();
    switch (task.state) {
    case 'done':
      return _.assign(operation, {
        description: `${action} deployment ${task.deployment} succeeded at ${timestamp}`,
        state: 'succeeded'
      });
    case 'error':
    case 'cancelled':
    case 'timeout':
      return _.assign(operation, {
        description: `${action} deployment ${task.deployment} failed at ${timestamp} with Error "${task.result}"`,
        state: 'failed'
      });
    default:
      return _.assign(operation, {
        description: `${action} deployment ${task.deployment} is still in progress`,
        state: 'in progress'
      });
    }
  }

  bind(params) {
    return this
      .initialize({
        type: 'bind'
      })
      .then(() => this.manager.createBinding(this.deploymentName, {
        id: params.binding_id,
        parameters: params.parameters || {}
      }))
      .tap(() => this
        .scheduleBackUp()
        .catch(() => {}));
  }

  unbind(params) {
    return this
      .initialize({
        type: 'unbind'
      })
      .then(() => this.manager.deleteBinding(this.deploymentName, params.binding_id));
  }

  buildSecurityGroupRules() {
    return _.map(this.manager.getNetwork(this.networkSegmentIndex), net => {
      return {
        protocol: 'tcp',
        destination: `${_.first(net.static)}-${_.last(net.static)}`,
        ports: '1024-65535'
      };
    });
  }

  getInfo() {
    const operation = {
      type: 'get'
    };
    return Promise
      .all([
        this.cloudController.getServiceInstance(this.guid),
        this.initialize(operation).then(() => this.manager.getDeploymentInfo(this.deploymentName))
      ])
      .spread((instance, deploymentInfo) => ({
        title: `${this.plan.service.metadata.displayName || 'Service'} Dashboard`,
        plan: this.plan,
        service: this.plan.service,
        instance: _.set(instance, 'task', deploymentInfo),
        files: [{
          id: 'status',
          title: 'Status',
          language: 'yaml',
          content: yaml.dump(deploymentInfo)
        }]
      }));
  }

  scheduleBackUp() {
    const options = {
      instance_id: this.guid,
      repeatInterval: 'daily',
      type: CONST.BACKUP.TYPE.ONLINE
    };
    logger.debug(`Scheduling backup for  instance : ${this.guid}`);
    return Promise
      .try(() => {
        if (utils.isFeatureEnabled(CONST.FEATURE.SCHEDULED_BACKUP)) {
          try {
            this.manager.verifyFeatureSupport('backup');
            ScheduleManager
              .getSchedule(this.guid, CONST.JOB.SCHEDULED_BACKUP)
              .then(schedule => {
                logger.info(`Backup Job : ${schedule.name} already scheduled for instance : ${this.guid} with interval ${schedule.repeatInterval}`);
                return;
              })
              .catch((error) => {
                if (typeof error !== errors.NotFound) {
                  //NotFound is an expected error.
                  logger.warn('error occurred while fetching schedule for existing job', error);
                }
                if (this.service.backup_interval) {
                  options.repeatInterval = this.service.backup_interval;
                }
                logger.info(`Scheduling Backup for instance : ${this.guid} with backup interval of - ${options.repeatInterval}`);
                //Even if there is an error while fetching backup schedule, trigger backup schedule we would want audit log captured and riemann alert sent
                return this.serviceFabrikClient.scheduleBackup(options);
              });
          } catch (err) {
            logger.error(`Error occurred while scheduling backup for instance: ${this.guid}. More info:`, err);
          }
        } else {
          logger.info('Scheduled Backup feature not enabled');
        }
      });
  }

  scheduleAutoUpdate() {
    const options = {
      instance_id: this.guid,
      repeatInterval: CONST.SCHEDULE.RANDOM,
      timeZone: _.get(config, 'scheduler.jobs.service_instance_update.time_zone', 'UTC')
    };
    return utils
      .retry(tries => {
        logger.info(`+-> ${CONST.ORDINALS[tries]} attempt to schedule auto update for : ${this.guid}`);
        if (utils.isFeatureEnabled(CONST.FEATURE.SCHEDULED_UPDATE)) {
          return this
            .serviceFabrikClient
            .scheduleUpdate(options)
            .catch(err => {
              logger.error(`Error occurred while setting up auto update for : ${this.guid}`, err);
              throw err;
            });
        } else {
          logger.warn(` Schedule update feature is disabled. Auto update not scheduled for instance : ${this.guid}`);
        }
      }, {
        maxAttempts: 3,
        minDelay: 1000
      })
      .catch(err => logger.error(`Error occurred while scheduling auto-update for instance: ${this.guid} - `, err));
  }
}

module.exports = DirectorInstance;