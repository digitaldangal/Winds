import '../loadenv';

import Queue from 'bull';
import normalize from 'normalize-url';
import ogs from 'open-graph-scraper';

// rss import model is needed because Article refs it
import RSS from '../models/rss'; // eslint-disable-line
import Podcast from '../models/podcast'; // eslint-disable-line

import Article from '../models/article';
import Episode from '../models/episode';

import '../utils/db';
import { Raven } from '../utils/errors';

import config from '../config';
import logger from '../utils/logger';

const ogQueue = new Queue('og', config.cache.uri);

logger.info('Starting the OG worker, now supporting podcasts, episodes and articles');
ogQueue.process(handleJob);

// Run the OG scraping job
function handleJob(job, done) {
	// Raven context for easy debugging in sentry
	Raven.context(() => {
		logger.info(`Processing opengraph images for ${job.data.url}...`);
		// Note dont normalize the url, this is done when the object is created
		const url = job.data.url;
		const jobType = job.data.type;
		let context = {
			jobType,
			url,
		};
		Raven.setContext(context);
		Raven.captureBreadcrumb(context);

		// Lookup the right type of schema: article, episode or podcast
		let schemaMap = {
			episode: Episode,
			podcast: Podcast,
		};
		let mongoSchema = schemaMap[jobType] || Article;
		let field = job.data.type === 'podcast' ? 'link' : 'url';

		mongoSchema
			.findOne({ [field]: url })
			.then(instance => {
				// if the instance hasn't been created yet, or it already has an OG image, ignore
				if (!instance || instance.images.og) {
					return done();
				} else if (url.endsWith('.mp3')) {
					// ends with mp3, no point in scraping, returning early
					return done();
				} else {
					return ogs({
						followAllRedirects: true,
						maxRedirects: 20,
						timeout: 3000,
						url: url,
					}).then(image => {
						if (!image.data.ogImage || !image.data.ogImage.url) {
							logger.info(`Didn't find image for ${url}`);
							return;
						} else {
							logger.info(`Found an image for ${url}`);
							let images = instance.images || {};
							images.og = normalize(image.data.ogImage.url);
							return mongoSchema.update(
								{ _id: instance._id },
								{ $set: { images: images } },
							);
						}
					});
				}
			})
			.then(() => {
				return done();
			})
			.catch(err => {
				let msg = 'Error retrieving/saving image for OG scraping';
				Raven.captureException(err);
				return done(err);
			});
	});
}
