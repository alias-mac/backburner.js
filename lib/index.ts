import {
  findItem,
  findTimer,
  getOnError,
  isCoercableNumber,
  isFunction,
  isString
} from './backburner/utils';

import searchTimer from './backburner/binary-search';
import DeferredActionQueues from './backburner/deferred-action-queues';
import iteratorDrain from './backburner/iterator-drain';

import Queue, { QUEUE_STATE } from './backburner/queue';

const now = Date.now;
const noop = function() {};

export default class Backburner {
  public static Queue = Queue;

  public DEBUG = false;

  public currentInstance: DeferredActionQueues | null = null;

  public options: any;

  private _onBegin: Function;
  private _onEnd: Function;
  private queueNames: string[];
  private instanceStack: DeferredActionQueues[];
  private _debouncees: any[];
  private _throttlers: any[];
  private _eventCallbacks: {
    end: Function[];
    begin: Function[];
  };

  private _timerTimeoutId: number | null = null;
  private _timers: any[];
  private _platform: {
    setTimeout(fn: () => void, ms: number): number;
    clearTimeout(id: number): void;
    next(fn: () => void): number;
    clearNext(fn): void;
  };

  private _boundRunExpiredTimers: () => void;

  private _autorun: number | null = null;
  private _boundAutorunEnd: () => void;

  constructor(queueNames: string[], options: any = {} ) {
    this.queueNames = queueNames;
    this.options = options;
    if (!this.options.defaultQueue) {
      this.options.defaultQueue = queueNames[0];
    }

    this.instanceStack = [];
    this._timers = [];
    this._debouncees = [];
    this._throttlers = [];
    this._eventCallbacks = {
      end: [],
      begin: []
    };

    this._onBegin = this.options.onBegin || noop;
    this._onEnd = this.options.onEnd || noop;

    let _platform = this.options._platform || {};
    let platform = Object.create(null);
    platform.setTimeout = _platform.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    platform.clearTimeout = _platform.clearTimeout || ((id) => clearTimeout(id));
    platform.next = _platform.next || ((fn) => platform.setTimeout(fn, 0));
    platform.clearNext = _platform.clearNext || platform.clearTimeout;

    this._platform = platform;

    this._boundRunExpiredTimers = () => {
      this._runExpiredTimers();
    };

    this._boundAutorunEnd = () => {
      this._autorun = null;
      this.end();
    };
  }

  /*
    @method begin
    @return instantiated class DeferredActionQueues
  */
  public begin(): DeferredActionQueues {
    let options = this.options;
    let previousInstance = this.currentInstance;
    let current;

    if (this._autorun !== null) {
      current = previousInstance;
      this._cancelAutorun();
    } else {
      if (previousInstance !== null) {
        this.instanceStack.push(previousInstance);
      }
      current = this.currentInstance = new DeferredActionQueues(this.queueNames, options);
      this._trigger('begin', current, previousInstance);
    }

    this._onBegin(current, previousInstance);

    return current;
  }

  public end() {
    let currentInstance = this.currentInstance;
    let nextInstance: DeferredActionQueues | null  = null;

    if (currentInstance === null) {
      throw new Error(`end called without begin`);
    }

    // Prevent double-finally bug in Safari 6.0.2 and iOS 6
    // This bug appears to be resolved in Safari 6.0.5 and iOS 7
    let finallyAlreadyCalled = false;
    let result;
    try {
      result = currentInstance.flush();
    } finally {
      if (!finallyAlreadyCalled) {
        finallyAlreadyCalled = true;

        if (result === QUEUE_STATE.Pause) {
          const next = this._platform.next;
          this._autorun = next(this._boundAutorunEnd);
        } else {
          this.currentInstance = null;

          if (this.instanceStack.length > 0) {
            nextInstance = this.instanceStack.pop();
            this.currentInstance = nextInstance;
          }
          this._trigger('end', currentInstance, nextInstance);
          this._onEnd(currentInstance, nextInstance);
        }
      }
    }
  }

  public on(eventName, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError(`Callback must be a function`);
    }
    let callbacks = this._eventCallbacks[eventName];
    if (callbacks !== undefined) {
      callbacks.push(callback);
    } else {
      throw new TypeError(`Cannot on() event ${eventName} because it does not exist`);
    }
  }

  public off(eventName, callback) {
    let callbacks = this._eventCallbacks[eventName];
    if (!eventName || callbacks === undefined) {
      throw new TypeError(`Cannot off() event ${eventName} because it does not exist`);
    }
    let callbackFound = false;
    if (callback) {
      for (let i = 0; i < callbacks.length; i++) {
        if (callbacks[i] === callback) {
          callbackFound = true;
          callbacks.splice(i, 1);
          i--;
        }
      }
    }
    if (!callbackFound) {
      throw new TypeError(`Cannot off() callback that does not exist`);
    }
  }

  public run(method: Function);
  public run(target: Function | any | null, method?: Function | string, ...args);
  public run(target: any | null | undefined, method?: any, ...args: any[]) {
    let length = arguments.length;
    let _method: Function | string;
    let _target: any | null | undefined;

    if (length === 1) {
      _method = target;
      _target = null;
    } else {
      _method = method;
      _target = target;

      if (isString(_method)) {
        _method = <Function> _target[_method];
      }
    }

    let onError = getOnError(this.options);

    this.begin();

    if (onError) {
      try {
        return _method.apply(_target, args);
      } catch (error) {
        onError(error);
      } finally {
        this.end();
      }
    } else {
      try {
        return _method.apply(_target, args);
      } finally {
        this.end();
      }
    }
  }

  /*
    Join the passed method with an existing queue and execute immediately,
    if there isn't one use `Backburner#run`.

    The join method is like the run method except that it will schedule into
    an existing queue if one already exists. In either case, the join method will
    immediately execute the passed in function and return its result.

    @method join
    @param {Object} target
    @param {Function} method The method to be executed
    @param {any} args The method arguments
    @return method result
  */
  public join(...args);
  public join() {
    if (this.currentInstance === null) {
      return this.run.apply(this, arguments);
    }

    let length = arguments.length;
    let method;
    let target;
    let args;

    if (length === 1) {
      method = arguments[0];
      target = null;
    } else {
      target = arguments[0];
      method = arguments[1];
      if (isString(method)) {
        method = <Function> target[method];
      }

      if (length > 2) {
        args = new Array(length - 2);
        for (let i = 0, l = length - 2; i < l; i++) {
          args[i] = arguments[i + 2];
        }
      }
    }

    let onError = getOnError(this.options);

    if (onError) {
      try {
        return method.apply(target, args);
      } catch (error) {
        onError(error);
      }
    } else {
      return method.apply(target, args);
    }
  }

  /**
   * @deprecated please use schedule instead.
   */
  public defer(queueName: string, ...args);
  public defer() {
    return this.schedule.apply(this, arguments);
  }

  /**
   * Schedule the passed function to run inside the specified queue.
   */
  public schedule(queueName: string, method: Function);
  public schedule<T, U extends keyof T>(queueName: string, target: T, method: U, ...args);
  public schedule(queueName: string, target: any | null, method: any | Function, ...args);
  public schedule(queueName: string) {
    let length = arguments.length;
    let method;
    let target;
    let args;

    if (length === 2) {
      method = arguments[1];
      target = null;
    } else {
      target = arguments[1];
      method = arguments[2];

      if (isString(method)) {
        method = <Function> target[method];
      }

      if (length > 3) {
        args = new Array(length - 3);
        for (let i = 3; i < length; i++) {
          args[i - 3] = arguments[i];
        }
      }
    }

    let stack = this.DEBUG ? new Error() : undefined;
    return this._ensureInstance().schedule(queueName, target, method, args, false, stack);
  }

  /*
    Defer the passed iterable of functions to run inside the specified queue.

    @method scheduleIterable
    @param {String} queueName
    @param {Iterable} an iterable of functions to execute
    @return method result
  */
  public scheduleIterable(queueName: string, iterable: Function) {
    let stack = this.DEBUG ? new Error() : undefined;
    return this._ensureInstance().schedule(queueName, null, iteratorDrain, [iterable], false, stack);
  }

  /**
   * @deprecated please use scheduleOnce instead.
   */
  public deferOnce(queueName: string, ...args);
  public deferOnce() {
    return this.scheduleOnce.apply(this, arguments);
  }

  /**
   * Schedule the passed function to run once inside the specified queue.
   */
  public scheduleOnce(queueName: string, method: Function);
  public scheduleOnce<T, U extends keyof T>(queueName: string, target: T, method: U, ...args);
  public scheduleOnce(queueName: string, target: any | null, method: any | Function, ...args);
  public scheduleOnce(queueName: string /* , target, method, args */) {
    let length = arguments.length;
    let method;
    let target;
    let args;

    if (length === 2) {
      method = arguments[1];
      target = null;
    } else {
      target = arguments[1];
      method = arguments[2];

      if (isString(method)) {
        method = <Function> target[method];
      }

      if (length > 3) {
        args = new Array(length - 3);
        for (let i = 3; i < length; i++) {
          args[i - 3] = arguments[i];
        }
      }
    }

    let stack = this.DEBUG ? new Error() : undefined;
    return this._ensureInstance().schedule(queueName, target, method, args, true, stack);
  }

  /**
   * @deprecated use later instead.
   */
  public setTimeout(...args);
  public setTimeout() {
    return this.later.apply(this, arguments);
  }

  public later()
  public later(...args) {
    let length = args.length;

    let wait = 0;
    let method;
    let target;
    let methodOrTarget;
    let methodOrWait;
    let methodOrArgs;

    if (length === 0) {
      return;
    } else if (length === 1) {
      method = args.shift();
    } else if (length === 2) {
      methodOrTarget = args[0];
      methodOrWait = args[1];

      if (isFunction(methodOrWait)) {
        target = args.shift();
        method = args.shift();
      } else if (methodOrTarget !== null && isString(methodOrWait) && methodOrWait in methodOrTarget) {
        target = args.shift();
        method = <Function> target[args.shift()];
      } else if (isCoercableNumber(methodOrWait)) {
        method = args.shift();
        wait = parseInt(args.shift(), 10);
      } else {
        method = args.shift();
      }
    } else {
      let last = args[args.length - 1];

      if (isCoercableNumber(last)) {
        wait = parseInt(args.pop(), 10);
      }

      methodOrTarget = args[0];
      methodOrArgs = args[1];

      if (isFunction(methodOrArgs)) {
        target = args.shift();
        method = args.shift();
      } else if (methodOrTarget !== null && isString(methodOrArgs) && methodOrArgs in methodOrTarget) {
        target = args.shift();
        method = target[args.shift()];
      } else {
        method = args.shift();
      }
    }

    let onError = getOnError(this.options);
    let executeAt = now() + wait;

    let fn;
    if (onError) {
      fn = function() {
        try {
          method.apply(target, args);
        } catch (e) {
          onError(e);
        }
      };
    } else {
      fn = function() {
        method.apply(target, args);
      };
    }

    return this._setTimeout(fn, executeAt);
  }

  public throttle(...args);
  public throttle(target, method /*, ...args, wait, [immediate] */) {
    let args = new Array(arguments.length);
    for (let i = 0; i < arguments.length; i++) {
      args[i] = arguments[i];
    }

    let immediate = args.pop();
    let isImmediate;
    let wait;
    let index;
    let timer;

    if (isCoercableNumber(immediate)) {
      wait = immediate;
      isImmediate = true;
    } else {
      wait = args.pop();
      isImmediate = immediate === true;
    }

    wait = parseInt(wait, 10);

    index = findItem(target, method, this._throttlers);
    if (index > -1) {
      return this._throttlers[index + 2];
    } // throttled

    timer = this._platform.setTimeout(() => {
      if (isImmediate === false) {
        this.run.apply(this, args);
      }
      index = findTimer(timer, this._throttlers);
      if (index > -1) {
        this._throttlers.splice(index, 3);
      }
    }, wait);

    if (isImmediate) {
      this.join.apply(this, args);
    }

    this._throttlers.push(target, method, timer);

    return timer;
  }

  public debounce(...args);
  public debounce(target, method /* , args, wait, [immediate] */) {
    let args = new Array(arguments.length);
    for (let i = 0; i < arguments.length; i++) {
      args[i] = arguments[i];
    }

    let immediate = args.pop();
    let isImmediate;
    let wait;
    let index;
    let timer;

    if (isCoercableNumber(immediate)) {
      wait = immediate;
      isImmediate = false;
    } else {
      wait = args.pop();
      isImmediate = immediate === true;
    }

    wait = parseInt(wait, 10);

    // Remove debouncee
    index = findItem(target, method, this._debouncees);
    if (index > -1) {
      let timerId = this._debouncees[index + 2];
      this._debouncees.splice(index, 3);
      this._platform.clearTimeout(timerId);
    }

    timer = this._platform.setTimeout(() => {
      if (isImmediate === false) {
        this.run.apply(this, args);
      }
      index = findTimer(timer, this._debouncees);
      if (index > -1) {
        this._debouncees.splice(index, 3);
      }
    }, wait);

    if (isImmediate && index === -1) {
      this.join.apply(this, args);
    }

    this._debouncees.push(target, method, timer);

    return timer;
  }

  public cancelTimers() {
    for (let i = 2; i < this._throttlers.length; i += 3) {
      this._platform.clearTimeout(this._throttlers[i]);
    }
    this._throttlers = [];

    for (let t = 2; t < this._debouncees.length; t += 3) {
      this._platform.clearTimeout(this._debouncees[t]);
    }
    this._debouncees = [];

    this._clearTimerTimeout();
    this._timers = [];

    this._cancelAutorun();
  }

  public hasTimers() {
    return this._timers.length > 0 || this._debouncees.length > 0 || this._throttlers.length > 0 || this._autorun !== null;
  }

  public cancel(timer?) {
    if (!timer) { return false; }
    let timerType = typeof timer;

    if (timerType === 'number' || timerType === 'string') { // we're cancelling a throttle or debounce
      return this._cancelItem(timer, this._throttlers) || this._cancelItem(timer, this._debouncees);
    } else if (timerType === 'function') { // we're cancelling a setTimeout
      return this._cancelLaterTimer(timer);
    } else if (timerType === 'object' && timer.queue && timer.method) { // we're cancelling a deferOnce
      return timer.queue.cancel(timer);
    }

    return false;
  }

  public ensureInstance() {
    this._ensureInstance();
  }

  private _cancelAutorun() {
    if (this._autorun !== null) {
      this._platform.clearNext(this._autorun);
      this._autorun = null;
    }
  }

  private _setTimeout(fn, executeAt) {
    if (this._timers.length === 0) {
      this._timers.push(executeAt, fn);
      this._installTimerTimeout();
      return fn;
    }

    // find position to insert
    let i = searchTimer(executeAt, this._timers);

    this._timers.splice(i, 0, executeAt, fn);

    // we should be the new earliest timer if i == 0
    if (i === 0) {
      this._reinstallTimerTimeout();
    }

    return fn;
  }

  private _cancelLaterTimer(timer) {
    for (let i = 1; i < this._timers.length; i += 2) {
      if (this._timers[i] === timer) {
        i = i - 1;
        this._timers.splice(i, 2); // remove the two elements
        if (i === 0) {
          this._reinstallTimerTimeout();
        }
        return true;
      }
    }
    return false;
  }

  private _cancelItem(timer, array) {
    let index = findTimer(timer, array);

    if (index > -1) {
      array.splice(index, 3);
      this._platform.clearTimeout(timer);
      return true;
    }
    return false;
  }

  /**
   Trigger an event. Supports up to two arguments. Designed around
   triggering transition events from one run loop instance to the
   next, which requires an argument for the first instance and then
   an argument for the next instance.

   @private
   @method _trigger
   @param {String} eventName
   @param {any} arg1
   @param {any} arg2
   */
  private _trigger<T, U>(eventName: string, arg1: T, arg2: U) {
    let callbacks = this._eventCallbacks[eventName];
    if (callbacks !== undefined) {
      for (let i = 0; i < callbacks.length; i++) {
        callbacks[i](arg1, arg2);
      }
    }
  }

  private _runExpiredTimers() {
    this._timerTimeoutId = null;
    if (this._timers.length === 0) { return; }
    this.begin();
    this._scheduleExpiredTimers();
    this.end();
  }

  private _scheduleExpiredTimers() {
    let timers = this._timers;
    let l = timers.length;
    let i = 0;
    let defaultQueue = this.options.defaultQueue;
    let n = now();
    for (; i < l; i += 2) {
      let executeAt = timers[i];
      if (executeAt <= n) {
        let fn = timers[i + 1];
        this.schedule(defaultQueue, null, fn);
      } else {
        break;
      }
    }

    timers.splice(0, i);
    this._installTimerTimeout();
  }

  private _reinstallTimerTimeout() {
    this._clearTimerTimeout();
    this._installTimerTimeout();
  }

  private _clearTimerTimeout() {
    if (this._timerTimeoutId === null) { return; }
    this._platform.clearTimeout(this._timerTimeoutId);
    this._timerTimeoutId = null;
  }

  private _installTimerTimeout() {
    if (this._timers.length === 0) { return; }
    let minExpiresAt = this._timers[0];
    let n = now();
    let wait = Math.max(0, minExpiresAt - n);
    this._timerTimeoutId = this._platform.setTimeout(this._boundRunExpiredTimers, wait);
  }

  private _ensureInstance(): DeferredActionQueues {
    let currentInstance = this.currentInstance;
    if (currentInstance === null) {
      currentInstance = this.begin();
      const next = this._platform.next;
      this._autorun = next(this._boundAutorunEnd);
    }
    return currentInstance;
  }
}
