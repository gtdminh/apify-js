import { checkParamOrThrow } from 'apify-client/build/utils';
import log from 'apify-shared/log';
import _ from 'underscore';
import Promise from 'bluebird';
import requestPromise from 'request-promise';
import Request from './request';
import events from './events';
import { ACTOR_EVENT_NAMES } from './constants';
import { getFirstKey } from './utils';
import { getValue, setValue } from './key_value_store';

// TODO: better tests
// TODO: this will not accept diacritict chars, IMHO we should have here a regexp
// that detects any hostname/whatever string
const URL_REGEX = '(http|https)://[\\w-]+(\\.[\\w-]+)+([\\w-.,@?^=%&:/~+#-]*[\\w@?^=%&;/~+#-])?';

/**
 * Helper function that validates unique.
 * Throws an error if uniqueKey is not nonempty string.
 *
 * @ignore
 */
const ensureUniqueKeyValid = (uniqueKey) => {
    if (typeof uniqueKey !== 'string' || !uniqueKey) {
        throw new Error('Request object\'s uniqueKey must be a non-empty string');
    }
};

/**
 * Provides way to handle a list of URLs to be crawled.
 * Each URL is represented using an instance of the `Request` class.
 *
 * `RequestList` has an internal state where it remembers handled requests, requests in progress and also reclaimed requests.
 * The state might be persisted in a key-value store as shown in the example below so if an act is restarted (due to internal
 * error or restart of the host machine) then the crawling can continue where it left off.
 *
 * Basic usage of `RequestList`:
 *
 * ```javascript
 * const requestList = new Apify.RequestList({
 *     sources: [
 *         // Separate requests
 *         { url: 'http://www.example.com/page-1', method: 'GET', headers: {} },
 *         { url: 'http://www.example.com/page-2', userData: { foo: 'bar' }},
 *
 *         // Bulk load of URLs from file `http://www.example.com/my-url-list.txt`
 *         // Note that all URLs must start with http:// or https://
 *         { requestsFromUrl: 'http://www.example.com/my-url-list.txt', userData: { isFromUrl: true } },
 *     ],
 *     persistStateKey: 'my-crawling-state'
 * });
 *
 * await requestList.initialize(); // Load requests.
 *
 * // Get requests from list
 * const request1 = await requestList.fetchNextRequest();
 * const request2 = await requestList.fetchNextRequest();
 * const request3 = await requestList.fetchNextRequest();
 *
 * // Mark some of them as handled
 * await requestList.markRequestHandled(request1);
 *
 * // If processing fails then reclaim it back to the list
 * await requestList.reclaimRequest(request2);
 * ```
 *
 * @param {Object} options
 * @param {Array} options.sources Function that processes a request. It must return a promise.
 * ```javascript
 * [
 *     // One URL
 *     { method: 'GET', url: 'http://example.com/a/b' },
 *     // Batch import of URLa from a file hosted on the web
 *     { method: 'POST', requestsFromUrl: 'http://example.com/urls.txt' },
 * ]
 * ```
 * @param {String} [options.persistStateKey] Key-value store key under which the `RequestList` persists its state. If this is set then `RequestList`
 *                                           persists its state in regular intervals and loads the state from there in a case that's restarted
 *                                           due to some error or migration to another worker machine.
 * @param {Object} [options.state] The state object that the `RequestList` will be initialized from.
 * It is in the form returned by `requestList.getState()`, such as follows:
 * ```javascript
 * {
 *     nextIndex: 5,
 *     nextUniqueKey: 'unique-key-5'
 *     inProgress: {
 *         'unique-key-1': true,
 *         'unique-key-4': true,
 *     },
 * }
 * ```
 * Note that the preferred (and simpler) way to persist the state of crawling of the `RequestList` is to use the `persistStateKey` parameter instead.
 */
export default class RequestList {
    constructor(opts = {}) {
        checkParamOrThrow(opts, 'options', 'Object');

        const { sources, persistStateKey, state } = opts;

        checkParamOrThrow(sources, 'options.sources', 'Array');
        checkParamOrThrow(state, 'options.state', 'Maybe Object');
        checkParamOrThrow(persistStateKey, 'options.persistStateKey', 'Maybe String');

        // We will initialize everything from this state in this.initialize();
        this.initialStatePromise = persistStateKey && !state
            ? getValue(persistStateKey)
            : Promise.resolve(state);

        // Array of all requests from all sources, in the order as they appeared in sources.
        // All requests in the array have distinct uniqueKey!
        this.requests = [];

        // Index to the next item in requests array to fetch. All previous requests are either handled or in progress.
        this.nextIndex = 0;

        // Dictionary, key is Request.uniqueKey, value is corresponding index in the requests array.
        this.uniqueKeyToIndex = {};

        // Dictionary of requests that were returned by fetchNextRequest().
        // The key is uniqueKey, value is true.
        this.inProgress = {};

        // Dictionary of requests for which reclaimRequest() was called.
        // The key is uniqueKey, value is true.
        // Note that reclaimedRequests is always a subset of inProgressRequests!
        this.reclaimed = {};

        // If this key is set then we persist url list into default key-value store under this key.
        this.persistStateKey = persistStateKey;
        this.isStatePersisted = true;

        this.isLoading = false;
        this.isInitialized = false;
        this.sources = sources;
    }

    /**
     * Loads all sources specified.
     *
     * @returns {Promise}
     */
    initialize() {
        if (this.isLoading) {
            throw new Error('RequestList sources are already loading or were loaded.');
        }
        this.isLoading = true;

        // We'll load all sources in sequence to ensure that they get loaded in the right order.
        return Promise
            .mapSeries(this.sources, (source) => {
                // TODO: One promise per each item is too much overheads, we could cluster items into single Promise.
                return source.requestsFromUrl
                    ? this._addRequestsFromUrl(source)
                    : Promise.resolve(this._addRequest(source));
            })
            .then(() => this.initialStatePromise)
            .then((state) => {
                if (!state) return;

                // Restore state
                if (typeof state.nextIndex !== 'number' || state.nextIndex < 0) {
                    throw new Error('The state object is invalid: nextIndex must be a non-negative number.');
                }
                if (state.nextIndex > this.requests.length) {
                    throw new Error('The state object is not consistent with RequestList: too few requests loaded.');
                }
                if (state.nextIndex < this.requests.length
                    && this.requests[state.nextIndex].uniqueKey !== state.nextUniqueKey) {
                    throw new Error('The state object is not consistent with RequestList: the order of URLs seems to have changed.');
                }

                const deleteFromInProgress = [];
                _.keys(state.inProgress).forEach((uniqueKey) => {
                    const index = this.uniqueKeyToIndex[uniqueKey];
                    if (typeof index !== 'number') {
                        throw new Error('The state object is not consistent with RequestList: unknown uniqueKey is present in the state.');
                    }
                    if (index >= state.nextIndex) {
                        deleteFromInProgress.push(uniqueKey);
                    }
                });

                // WORKAROUND:
                // It happened to some users that state object contained something like:
                // {
                //   "nextIndex": 11308,
                //   "nextUniqueKey": "https://www.anychart.com",
                //   "inProgress": {
                //      "https://www.ams360.com": true,
                //      ...
                //        "https://www.anychart.com": true,
                // }
                // Which then caused error "The request is not being processed (uniqueKey: https://www.anychart.com)"
                // As a workaround, we just remove all inProgress requests whose index >= nextIndex,
                // since they will be crawled again.
                if (deleteFromInProgress.length) {
                    log.warning('RequestList\'s in-progress field is not consistent, skipping invalid in-progress entries', { deleteFromInProgress });
                    _.each(deleteFromInProgress, (uniqueKey) => {
                        delete state.inProgress[uniqueKey];
                    });
                }

                this.nextIndex = state.nextIndex;
                this.inProgress = state.inProgress;

                // All in-progress requests need to be recrawled
                this.reclaimed = _.clone(this.inProgress);
            })
            .then(() => {
                this.isInitialized = true;

                if (!this.persistStateKey) return;

                events.on(ACTOR_EVENT_NAMES.PERSIST_STATE, () => {
                    if (this.isStatePersisted) return;

                    return setValue(this.persistStateKey, this.getState())
                        .then(() => {
                            this.isStatePersisted = true;
                        })
                        .catch((err) => {
                            log.exception(err, 'RequestList: Cannot persist state', { persistStateKey: this.persistStateKey });
                        });
                });
            });
    }

    /**
     * Returns an object representing the state of the RequestList instance. Do not alter the resulting object!
     *
     * @returns Object
     */
    getState() {
        this._ensureIsInitialized();

        return {
            nextIndex: this.nextIndex,
            nextUniqueKey: this.nextIndex < this.requests.length
                ? this.requests[this.nextIndex].uniqueKey
                : null,
            inProgress: this.inProgress,
        };
    }

    /**
     * Returns `true` if the next call to `fetchNextRequest()` will return null, otherwise it returns `false`.
     * Note that even if the list is empty, there might be some pending requests currently being processed.
     *
     * @returns {Promise<boolean>}
     */
    isEmpty() {
        return Promise
            .resolve()
            .then(() => {
                this._ensureIsInitialized();

                return !getFirstKey(this.reclaimed) && this.nextIndex >= this.requests.length;
            });
    }

    /**
     * Returns `true` if all requests were already handled and there are no more left.
     *
     * @returns {Promise<boolean>}
     */
    isFinished() {
        return Promise
            .resolve()
            .then(() => {
                this._ensureIsInitialized();

                return !getFirstKey(this.inProgress) && this.nextIndex >= this.requests.length;
            });
    }

    /**
     * Returns next request which is the reclaimed one if available or next upcoming request otherwise.
     *
     * @returns {Promise<Request>}
     */
    fetchNextRequest() {
        return Promise
            .resolve()
            .then(() => {
                this._ensureIsInitialized();

                // First return reclaimed requests if any.
                const uniqueKey = getFirstKey(this.reclaimed);
                if (uniqueKey) {
                    delete this.reclaimed[uniqueKey];
                    const index = this.uniqueKeyToIndex[uniqueKey];
                    return this.requests[index];
                }

                // Otherwise return next request.
                if (this.nextIndex < this.requests.length) {
                    const request = this.requests[this.nextIndex];
                    this.inProgress[request.uniqueKey] = true;
                    this.nextIndex++;
                    this.isStatePersisted = false;
                    return request;
                }

                return null;
            });
    }

    /**
     * Marks request handled after successfull processing.
     *
     * @param {Request} request
     *
     * @returns {Promise}
     */
    markRequestHandled(request) {
        return Promise
            .resolve()
            .then(() => {
                const { uniqueKey } = request;

                ensureUniqueKeyValid(uniqueKey);
                this._ensureInProgressAndNotReclaimed(uniqueKey);
                this._ensureIsInitialized();

                delete this.inProgress[uniqueKey];
                this.isStatePersisted = false;
            });
    }

    /**
     * Reclaims request to the list if its processing failed.
     * The request will become available in the next `this.fetchNextRequest()`.
     *
     * @param {Request} request
     *
     * @returns {Promise}
     */
    reclaimRequest(request) {
        return Promise
            .resolve()
            .then(() => {
                const { uniqueKey } = request;

                ensureUniqueKeyValid(uniqueKey);
                this._ensureInProgressAndNotReclaimed(uniqueKey);
                this._ensureIsInitialized();

                this.reclaimed[uniqueKey] = true;
            });
    }

    /**
     * Adds all requests from a file string.
     *
     * @ignore
     */
    _addRequestsFromUrl(source) {
        const sharedOpts = _.omit(source, 'requestsFromUrl', 'regex');
        const {
            requestsFromUrl,
            regex = URL_REGEX,
        } = source;

        return requestPromise.get(requestsFromUrl)
            .then((urlsStr) => {
                const urlsArr = urlsStr.match(new RegExp(regex, 'gi'));
                const originalLength = this.requests.length;

                if (urlsArr) {
                    urlsArr.forEach(url => this._addRequest(_.extend({ url }, sharedOpts)));

                    const fetchedCount = urlsArr.length;
                    const importedCount = this.requests.length - originalLength;

                    log.info('RequestList: list fetched', {
                        requestsFromUrl,
                        regex,
                        fetchedCount,
                        importedCount,
                        duplicateCount: fetchedCount - importedCount,
                        sample: JSON.stringify(urlsArr.slice(0, 5)),
                    });
                } else {
                    log.warning('RequestList: list fetched but it is empty', {
                        requestsFromUrl,
                        regex,
                    });
                }
            })
            .catch((err) => {
                log.exception(err, 'RequestList: Cannot fetch a request list', { requestsFromUrl, regex });
                throw new Error(`Cannot fetch a request list from ${requestsFromUrl}: ${err}`);
            });
    }

    /**
     * Adds given request.
     * If opts parameter is plain object not instance of an Requests then creates it.
     *
     * @ignore
     */
    _addRequest(opts) {
        const request = opts instanceof Request
            ? opts
            : new Request(opts);

        const { uniqueKey } = request;
        ensureUniqueKeyValid(uniqueKey);

        // Skip requests with duplicate uniqueKey
        if (this.uniqueKeyToIndex[uniqueKey] === undefined) {
            this.uniqueKeyToIndex[uniqueKey] = this.requests.length;
            this.requests.push(request);
        }
    }

    /**
     * Checks that request is not reclaimed and throws an error if so.
     *
     * @ignore
     */
    _ensureInProgressAndNotReclaimed(uniqueKey) {
        if (!this.inProgress[uniqueKey]) {
            throw new Error(`The request is not being processed (uniqueKey: ${uniqueKey})`);
        }
        if (this.reclaimed[uniqueKey]) {
            throw new Error(`The request was already reclaimed (uniqueKey: ${uniqueKey})`);
        }
    }

    /**
     * Throws an error if request list wasn't initialized.
     *
     * @ignore
     */
    _ensureIsInitialized() {
        if (!this.isInitialized) {
            throw new Error('RequestList is not initialized. You must call "await requestList.initialize();" before using it!');
        }
    }

    /**
     * Returns the total number of unique requests present in the `RequestList`.
     */
    length() {
        return this.requests.length;
    }
}
